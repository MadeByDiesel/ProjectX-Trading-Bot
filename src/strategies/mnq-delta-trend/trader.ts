// src/strategies/mnq-delta-trend/trader.ts
import { ProjectXClient } from '../../services/projectx-client';
import { MNQDeltaTrendCalculator } from './calculator';
import { StrategyConfig } from './types'; // uses your local MNQ types
import { GatewayQuote, BarData } from '../../types'; // SignalR types come from global app types
import { execFile, ExecFileException, ExecFileOptionsWithStringEncoding } from 'child_process';

export class MNQDeltaTrendTrader {
  private client: ProjectXClient;
  private calculator: MNQDeltaTrendCalculator;
  private config: StrategyConfig;

  private contractId: string;
  private symbol: string;

  // Tick → bar accumulators
  private lastPriceByContract = new Map<string, number>();
  private lastCumVolByContract = new Map<string, number>();
  private signedVolInBarByContract = new Map<string, number>();
  private volInBarByContract = new Map<string, number>();

  // Open 3m bar state
  private barOpenPx: number | null = null;
  private barHighPx: number | null = null;
  private barLowPx: number | null = null;
  private barStartMs: number | null = null; // start time (bucket) in ms
  private readonly barStepMs = 3 * 60 * 1000; // 3-minute bars

  private running = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private isFlattening = false;

  // Minimal market state; calculator maintains ATR/HTF internally after warm-up
  private marketState = {
    atr: 0,
    higherTimeframeTrend: 'neutral' as 'bullish' | 'bearish' | 'neutral',
    deltaCumulative: 0
  };

  // Keep a bound handler so we can remove/ignore as needed
  private marketDataHandler = (q: GatewayQuote & { contractId: string }) => this.onQuote(q);

  /** Post trade events to the local NT8 webhook listener (curl-based, no deps) */
  private async postWebhook(action: 'BUY' | 'SELL' | 'FLAT', qty?: number): Promise<void> {
    // honor config switch
    if (!this.config?.sendWebhook) return;
    const base = this.config.webhookUrl || '';
    if (!base) return;

    // If url has no query and we have a secret, append it. If it already has ?, leave it as-is.
    const secret = (this as any).config?.webhookSecret;
    const url = (!base.includes('?') && secret) ? `${base}?secret=${secret}` : base;

    // NT8: qty > 0 required for BUY/SELL; FLAT must omit qty
    const payload: Record<string, any> = { symbol: 'MNQ', action };
    if (action !== 'FLAT') payload.qty = Math.max(1, Number(qty ?? 1));

    const body = JSON.stringify(payload);

    // Bind to your fixed LAN interface (override via config if you want)
    const localIf = (this as any).config?.webhookInterface || '192.168.4.50';

    const args: string[] = [
      '--interface', localIf,
      '--fail',                 // make 4xx/5xx exit non-zero
      '-sS',                    // quiet but show errors
      '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '--max-time', '3',        // seconds (curl-level timeout)
      '--data-binary', body,
      url
    ];

    const opts: ExecFileOptionsWithStringEncoding = {
      timeout: 4000,            // child-process timeout (a bit higher than curl)
      encoding: 'utf8'
    };

    await new Promise<void>((resolve) => {
      execFile(
        '/usr/bin/curl',
        args,
        opts,
        (error: ExecFileException | null, stdout: string, stderr: string) => {
          if (error) {
            console.error('[webhook] curl error', error.message, stderr || '');
            return resolve();
          }
          // OK (curl --fail succeeded). NT8 usually returns {"status":"accepted"}
          if (stdout?.trim()) {
            console.info('[webhook] sent', payload, 'resp=', stdout.trim());
          } else {
            console.info('[webhook] sent', payload);
          }
          resolve();
        }
      );
    });
  }

  constructor(opts: {
    client: ProjectXClient;
    calculator: MNQDeltaTrendCalculator;
    config: StrategyConfig;
    contractId: string;
    symbol: string;
  }) {
    this.client = opts.client;
    this.calculator = opts.calculator;
    this.config = opts.config;
    this.contractId = opts.contractId;
    this.symbol = opts.symbol;
  }

  /** Call once to start streaming. */
  public async start(): Promise<void> {
    this.running = true;

    // Ensure WS connected & subscribed
    await this.client.connectWebSocket();
    await this.client.getSignalRService().subscribeToMarketData(this.contractId);

    // Wire the handler
    this.client.onMarketData(this.marketDataHandler);

    // Heartbeat to close bars across minute boundaries even if a boundary tick is late
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (!this.running) return;
      this.maybeCloseBarByClock();
    }, 1000);

    console.info(`[MNQDeltaTrend][Trader] started for ${this.symbol} (contractId=${this.contractId})`);

  }

  /** Optional: stop receiving data & clear timers. Safe to call multiple times. */
  public async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    // We can’t unregister the callback from SignalRService (no .off), so we guard with this.running flag
    // Disconnect websocket to be clean
    try { await this.client.disconnectWebSocket(); } catch {}
    console.info('[MNQDeltaTrend][Trader] stopped');
  }

  private onQuote(quote: GatewayQuote & { contractId: string }): void {
    if (!this.running) return;
    if (quote.contractId !== this.contractId) return;

    const contractId = quote.contractId;
    const px = quote.lastPrice;
    if (!Number.isFinite(px)) return;

    // First quote log (once)
    if (!this.lastPriceByContract.has(contractId)) {
      console.debug(`[MNQDeltaTrend][onQuote:first] ${this.symbol} px=${px}, vol=${quote.volume}`);
    }

    // ---------- accumulate per-tick volume & signed volume ----------
    // SignalR GatewayQuote.volume is cumulative session volume
    const cumVol = (quote as any).volume ?? 0;
    const prevPx = this.lastPriceByContract.get(contractId);
    const prevCum = this.lastCumVolByContract.get(contractId);

    let dVol = 0;
    if (typeof prevCum === 'number' && cumVol >= prevCum) dVol = cumVol - prevCum;

    let signed = 0;
    if (typeof prevPx === 'number') {
      if (px > prevPx) signed = dVol;
      else if (px < prevPx) signed = -dVol;
      else signed = 0;
    }

    this.volInBarByContract.set(
      contractId,
      (this.volInBarByContract.get(contractId) ?? 0) + (Number.isFinite(dVol) ? dVol : 0)
    );
    this.signedVolInBarByContract.set(
      contractId,
      (this.signedVolInBarByContract.get(contractId) ?? 0) + (Number.isFinite(signed) ? signed : 0)
    );

    this.lastPriceByContract.set(contractId, px);
    this.lastCumVolByContract.set(contractId, cumVol);

        // ---------- tick-level protective exits (stop/trail) ----------
    if (this.calculator.hasPosition() && !this.isFlattening) {
      const hit = this.calculator.onTickForProtectiveStops(px, this.marketState.atr ?? 0);
      if (hit === 'hitStop' || hit === 'hitTrail') {
        const dir = this.calculator.getPositionDirection();
        console.info(
          `[MNQDeltaTrend][EXIT] ${hit} (tick) { px: ${px}, atr: ${this.marketState.atr}, dir: ${dir} }`
        );

        this.isFlattening = true;
        // Fire-and-forget close to avoid making onQuote async
        this.client.closePosition(this.contractId)
          .then(() => {
            console.info('[MNQDeltaTrend][EXIT] flattened via closePosition');
            this.calculator.clearPosition();
            this.isFlattening = false;

            if (this.config.sendWebhook) {
              this.postWebhook('FLAT');
            }

          })
          .catch((err) => {
            console.error('[MNQDeltaTrend][EXIT] flatten failed:', err);
            // allow retry on next tick
            this.isFlattening = false;
          });
      }
    }

    // ---------- 3-minute bar bucketing ----------
    const nowMs = Date.now();
    const bucketStart = Math.floor(nowMs / this.barStepMs) * this.barStepMs;

    // first tick ever or first tick of a new bucket
    if (this.barStartMs === null) {
      this.barStartMs = bucketStart;
      this.barOpenPx = px;
      this.barHighPx = px;
      this.barLowPx = px;
      console.debug(`[MNQDeltaTrend][barOpen] ${new Date(this.barStartMs).toISOString()} O=${px}`);
      return;
    }

    if (bucketStart > this.barStartMs) {
      // crossed into a new bucket → close prior bar and open new one with this tick
      this.closeBarAndProcess();
      this.barStartMs = bucketStart;
      this.barOpenPx = px;
      this.barHighPx = px;
      this.barLowPx = px;
      console.debug(`[MNQDeltaTrend][barOpen] ${new Date(this.barStartMs).toISOString()} O=${px}`);
      return;
    }

    // update current open bar extremes
    if (this.barHighPx !== null) this.barHighPx = Math.max(this.barHighPx, px);
    if (this.barLowPx !== null) this.barLowPx = Math.min(this.barLowPx, px);
  }

  /** Heartbeat: if the wall-clock bucket advanced but we haven’t seen a tick yet, close bar anyway */
  private maybeCloseBarByClock(): void {
    if (!this.running) return;
    if (this.barStartMs === null) return;

    const nowMs = Date.now();
    const bucketStart = Math.floor(nowMs / this.barStepMs) * this.barStepMs;
    if (bucketStart > this.barStartMs) {
      // If we have a last price, use it as close; otherwise we cannot close
      const lastPx = this.lastPriceByContract.get(this.contractId);
      if (!Number.isFinite(lastPx)) return;

      this.closeBarAndProcess();

      // Open the new bar with last price until next tick updates it
      this.barStartMs = bucketStart;
      this.barOpenPx = lastPx!;
      this.barHighPx = lastPx!;
      this.barLowPx = lastPx!;
      console.debug(`[MNQDeltaTrend][barOpen:HB] ${new Date(this.barStartMs).toISOString()} O=${lastPx}`);
    }
  }

  private closeBarAndProcess(): void {
    if (this.barStartMs === null || this.barOpenPx === null || this.barHighPx === null || this.barLowPx === null) {
      return;
    }

    const contractId = this.contractId;
    const closePx = this.lastPriceByContract.get(contractId);
    if (!Number.isFinite(closePx)) return;

    const volume = Math.max(0, Math.floor(this.volInBarByContract.get(contractId) ?? 0));
    const signed = Math.trunc(this.signedVolInBarByContract.get(contractId) ?? 0);

    const barEndIso = new Date(this.barStartMs + this.barStepMs - 1).toISOString(); // close timestamp

    const closedBar: BarData = {
      timestamp: barEndIso,
      open: this.barOpenPx,
      high: this.barHighPx,
      low: this.barLowPx,
      close: closePx!,
      volume: volume,
      delta: signed, // Pine parity: signed volume
    };

    // reset accumulators for next bar
    this.volInBarByContract.set(contractId, 0);
    this.signedVolInBarByContract.set(contractId, 0);

    // let calculator handle indicators & signals
    const signal = this.calculator.processNewBar(closedBar as any, this.marketState as any);
    this.handleSignal(signal, closedBar);

    console.debug(
      `[MNQDeltaTrend][barClose] t=${closedBar.timestamp} O:${closedBar.open} H:${closedBar.high} L:${closedBar.low} C:${closedBar.close} Δ:${closedBar.delta} V:${closedBar.volume}`
    );

    // prepare for next bar defaults (the opener is set in onQuote or heartbeat)
    this.barOpenPx = closePx!;
    this.barHighPx = closePx!;
    this.barLowPx = closePx!;
  }

  private async handleSignal(
    signal: { signal: 'buy' | 'sell' | 'hold'; reason: string; confidence: number },
    bar: BarData
  ) {
    // Respect calculator's hold — never place orders on HOLD
    if (signal.signal === 'hold') {
      console.debug('[MNQDeltaTrend][order] HOLD:', signal.reason);
      return;
    }
    // Do not add to position (no pyramiding)
    if (this.calculator.hasPosition()) {
      if (signal.signal === 'buy' || signal.signal === 'sell') {
        console.debug('[MNQDeltaTrend][order] skipped: already in position');
        return;
      }
    }
    // Enforce ATR gate at the trader layer (prevents sub-threshold entries)
    const minAtr = Math.max(0, this.config.minAtrToTrade ?? 0);
    const atrNow = this.marketState.atr ?? 0;
    if (!Number.isFinite(atrNow) || atrNow < minAtr) {
      console.debug(
        `[MNQDeltaTrend][order] blocked: ATR gate failed (atr=${atrNow}, thresh=${minAtr})`
      );
      return;
    }
    const direction = signal.signal === 'buy' ? 'long' : 'short';
    const atr = this.marketState.atr ?? 0;
    const acctBal = await this.client.getEquity();
    const qty = Math.max(1, this.calculator.calculatePositionSize(bar.close, atr, acctBal));

    console.info(`[MNQDeltaTrend][order] ${signal.signal.toUpperCase()} qty=${qty} reason="${signal.reason}"`);

    try {
      await this.client.createOrder({
        contractId: this.contractId,
        type: 2, // Market (Topstep: 2=Market)
        side: signal.signal === 'buy' ? 0 : 1, // Topstep: 0=Buy(Bid), 1=Sell(Ask)
        size: qty,
      });

      // Inform calculator (for trailing stop anchors)
      // Use public hook if present; otherwise, guard with try
      try {
        (this.calculator as any).setPosition?.(bar.close, direction, atr);
      } catch {}

      // ✅ Send ENTRY webhook only after order success
      try {
        // after order success
        if (this.config.sendWebhook) {
          this.postWebhook(signal.signal === 'buy' ? 'BUY' : 'SELL', qty);
        }
      } catch (err) {
        console.error('[webhook] entry post failed', err);
      }

    } catch (err) {
      console.error('[MNQDeltaTrend][order] placement failed:', err);
    }
  }
}