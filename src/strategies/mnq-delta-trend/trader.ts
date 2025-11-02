import { ProjectXClient } from '../../services/projectx-client';
import { MNQDeltaTrendCalculator } from './calculator';
import { StrategyConfig } from './types';
import { GatewayQuote, BarData } from '../../types';
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
  private barStartMs: number | null = null;
  private readonly barStepMs = 3 * 60 * 1000;

  // Live forming bar tracking for intra-bar detection
  private liveBarOpen: number | null = null;
  private liveBarHigh: number | null = null;
  private liveBarLow: number | null = null;
  private liveBarStartMs: number | null = null;
  private lastIntraBarCheckMs = 0;

  // Per-bar entry tracking and async lock
  private enteredBarStartMs: number | null = null;
  private isEnteringPosition = false;

  private running = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private isFlattening = false;

  // Minimal market state
  private marketState = {
    atr: 0,
    higherTimeframeTrend: 'neutral' as 'bullish' | 'bearish' | 'neutral',
    deltaCumulative: 0
  };

  private marketDataHandler = (q: GatewayQuote & { contractId: string }) => this.onQuote(q);

  /** Optional: Post trade events to the local NT8 webhook listener */
  private async postWebhook(action: 'BUY' | 'SELL' | 'FLAT', qty?: number): Promise<void> {
    if (!(this.config as any)?.sendWebhook) return;
    const base = (this.config as any).webhookUrl || '';
    if (!base) return;

    const secret = (this.config as any).webhookSecret;
    const url = (!base.includes('?') && secret) ? `${base}?secret=${secret}` : base;

    const payload: Record<string, any> = { symbol: this.symbol, action };
    if (action !== 'FLAT') payload.qty = Math.max(1, Number(qty ?? 1));

    const body = JSON.stringify(payload);
    const localIf = (this.config as any).webhookInterface || '192.168.4.50';

    const args: string[] = [
      '--interface', localIf,
      '--fail',
      '-sS',
      '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '--max-time', '3',
      '--data-binary', body,
      url
    ];

    const opts: ExecFileOptionsWithStringEncoding = { timeout: 4000, encoding: 'utf8' };

    await new Promise<void>((resolve) => {
      execFile('/usr/bin/curl', args, opts, (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error) {
          console.error('[webhook] curl error', error.message, stderr || '');
          return resolve();
        }
        if (stdout?.trim()) console.info('[webhook] sent', payload, 'resp=', stdout.trim());
        else console.info('[webhook] sent', payload);
        resolve();
      });
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

  public async start(): Promise<void> {
    this.running = true;

    await this.client.connectWebSocket();
    await this.client.getSignalRService().subscribeToMarketData(this.contractId);
    this.client.onMarketData(this.marketDataHandler);

    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (!this.running) return;
      this.maybeCloseBarByClock();
    }, 1000);

    console.info(`[MNQDeltaTrend][Trader] started for ${this.symbol} (contractId=${this.contractId})`);
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    try { await this.client.disconnectWebSocket(); } catch {}
    console.info('[MNQDeltaTrend][Trader] stopped');
  }

  private onQuote(quote: GatewayQuote & { contractId: string }): void {
    if (!this.running) return;
    if (quote.contractId !== this.contractId) return;

    const contractId = quote.contractId;
    const px = quote.lastPrice;
    if (!Number.isFinite(px)) return;

    if (!this.lastPriceByContract.has(contractId)) {
      console.debug(`[MNQDeltaTrend][onQuote:first] ${this.symbol} px=${px}, vol=${(quote as any).volume}`);
    }

    // Accumulate per-tick volume & signed volume
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

    this.volInBarByContract.set(contractId, (this.volInBarByContract.get(contractId) ?? 0) + (Number.isFinite(dVol) ? dVol : 0));
    this.signedVolInBarByContract.set(contractId, (this.signedVolInBarByContract.get(contractId) ?? 0) + (Number.isFinite(signed) ? signed : 0));

    this.lastPriceByContract.set(contractId, px);
    this.lastCumVolByContract.set(contractId, cumVol);

    // Tick-level protective exits (stop/trail)
    if (this.calculator.hasPosition() && !this.isFlattening && !this.isEnteringPosition) {
      const hit = this.calculator.onTickForProtectiveStops(px, this.marketState.atr ?? 0);
      if (hit === 'hitStop' || hit === 'hitTrail') {
        const dir = this.calculator.getPositionDirection();
        console.info(`[MNQDeltaTrend][EXIT] ${hit} (tick) { px: ${px}, atr: ${this.marketState.atr}, dir: ${dir} }`);

        this.isFlattening = true;
        this.client.closePosition(this.contractId)
          .then(() => {
            console.info('[MNQDeltaTrend][EXIT] flattened via closePosition');
            this.calculator.clearPosition();
            this.isFlattening = false;

            // Allow bar-close path to re-enter this same bar after an intrabar scratch
            this.enteredBarStartMs = null;

            if ((this.config as any).sendWebhook) this.postWebhook('FLAT');
          })
          .catch((err) => {
            console.error('[MNQDeltaTrend][EXIT] flatten failed:', err);
            this.isFlattening = false;
          });
      }
    }

    // 3-minute bar bucketing
    const nowMs = Date.now();
    const bucketStart = Math.floor(nowMs / this.barStepMs) * this.barStepMs;

    // First tick ever or first tick of a new bucket
    if (this.barStartMs === null) {
      this.barStartMs = bucketStart;
      this.barOpenPx = px;
      this.barHighPx = px;
      this.barLowPx = px;

      this.liveBarOpen = px;
      this.liveBarHigh = px;
      this.liveBarLow = px;
      this.liveBarStartMs = nowMs;

      console.debug(`[MNQDeltaTrend][barOpen] ${new Date(this.barStartMs).toISOString()} O=${px}`);
      return;
    }

    if (bucketStart > this.barStartMs) {
      // Close prior bar and open new one
      this.closeBarAndProcess();

      this.barStartMs = bucketStart;
      this.barOpenPx = px;
      this.barHighPx = px;
      this.barLowPx = px;

      // Reset per-bar entry and calculator cooldowns for new bar
      this.enteredBarStartMs = null;
      this.calculator.resetIntraBarTracking();
      this.calculator.clearCooldowns();

      this.liveBarOpen = px;
      this.liveBarHigh = px;
      this.liveBarLow = px;
      this.liveBarStartMs = nowMs;
      this.lastIntraBarCheckMs = 0;

      console.debug(`[MNQDeltaTrend][barOpen] ${new Date(this.barStartMs).toISOString()} O=${px}`);
      return;
    }

    // Update current bar extremes
    if (this.barHighPx !== null) this.barHighPx = Math.max(this.barHighPx, px);
    if (this.barLowPx !== null) this.barLowPx = Math.min(this.barLowPx, px);
    if (this.liveBarHigh !== null) this.liveBarHigh = Math.max(this.liveBarHigh, px);
    if (this.liveBarLow !== null) this.liveBarLow = Math.min(this.liveBarLow, px);

    // Intra-bar delta signal check
    if ((this.config as any).useIntraBarDetection && !this.calculator.hasPosition() && !this.isFlattening) {
      const checkIntervalMs = (this.config as any).intraBarCheckIntervalMs ?? 100;
      if ((nowMs - this.lastIntraBarCheckMs) >= checkIntervalMs) {
        this.lastIntraBarCheckMs = nowMs;
        this.checkIntraBarSignal(px, nowMs);
      }
    }
  }

  private maybeCloseBarByClock(): void {
    if (!this.running) return;
    if (this.barStartMs === null) return;

    const nowMs = Date.now();
    const bucketStart = Math.floor(nowMs / this.barStepMs) * this.barStepMs;
    if (bucketStart > this.barStartMs) {
      const lastPx = this.lastPriceByContract.get(this.contractId);
      if (!Number.isFinite(lastPx)) return;

      this.closeBarAndProcess();

      this.barStartMs = bucketStart;
      this.barOpenPx = lastPx!;
      this.barHighPx = lastPx!;
      this.barLowPx = lastPx!;

      // Reset per-bar entry and calculator cooldowns for new bar
      this.enteredBarStartMs = null;
      this.calculator.resetIntraBarTracking();
      this.calculator.clearCooldowns();

      this.liveBarOpen = lastPx!;
      this.liveBarHigh = lastPx!;
      this.liveBarLow = lastPx!;
      this.liveBarStartMs = nowMs;
      this.lastIntraBarCheckMs = 0;

      console.debug(`[MNQDeltaTrend][barOpen:HB] ${new Date(this.barStartMs).toISOString()} O=${lastPx}`);
    }
  }

  private checkIntraBarSignal(currentPrice: number, _nowMs: number): void {
    if (!this.liveBarOpen || !this.liveBarHigh || !this.liveBarLow || !this.liveBarStartMs) return;

    // Per-bar entry limit: only one entry per 3-minute bar
    if (this.enteredBarStartMs === this.barStartMs) return;

    // Reset delta accumulation at first intrabar check of new bar
    if (this.lastIntraBarCheckMs === 0) {
      this.signedVolInBarByContract.set(this.contractId, 0);
      this.volInBarByContract.set(this.contractId, 0);
    }

    const currentDelta = this.signedVolInBarByContract.get(this.contractId) ?? 0;
    const currentVolume = this.volInBarByContract.get(this.contractId) ?? 0;

    const formingBar: BarData = {
      timestamp: new Date(this.barStartMs!).toISOString(),
      open: this.liveBarOpen,
      high: this.liveBarHigh,
      low: this.liveBarLow,
      close: currentPrice,
      volume: currentVolume,
      delta: currentDelta,
    };

    const signal = this.calculator.evaluateFormingBar(formingBar, this.marketState as any);

    if (signal.signal === 'buy' || signal.signal === 'sell') {
      console.info(
        `[MNQDeltaTrend][INTRA-BAR SIGNAL] ${signal.signal.toUpperCase()} Δ=${currentDelta} px=${currentPrice} reason="${signal.reason}"`
      );
      void this.executeIntraBarSignal(signal, formingBar);
    }
  }

  private async executeIntraBarSignal(
    signal: { signal: 'buy' | 'sell' | 'hold'; reason: string; confidence: number },
    bar: BarData
  ): Promise<void> {
    if (signal.signal === 'hold') return;
    if (this.calculator.hasPosition()) return;
    if (this.isFlattening) return;

    // Async execution lock
    if (this.isEnteringPosition) return;

    // Per-bar entry limit (race guard)
    if (this.enteredBarStartMs === this.barStartMs) return;

    this.isEnteringPosition = true;

    // Pre-mark the bar to block bar-close path; rollback only on failure
    const barGate = this.barStartMs;
    this.enteredBarStartMs = barGate;

    try {
      const direction = signal.signal === 'buy' ? 'long' : 'short';

      // Pine-accurate ATR gate using the forming bar snapshot
      let atr = this.marketState.atr ?? 0;
      try { atr = this.calculator.atrWithForming(bar); } catch {}

      const minAtr = Math.max(0, this.config.minAtrToTrade ?? 0);
      if (!Number.isFinite(atr) || atr < minAtr) {
        this.enteredBarStartMs = null;
        this.isEnteringPosition = false;
        return;
      }

      const qty = Math.max(1, this.config.contractQuantity ?? 1);

      await this.client.createOrder({
        contractId: this.contractId,
        type: 2,
        side: signal.signal === 'buy' ? 0 : 1,
        size: qty,
      });

      this.calculator.setPosition(bar.close, direction, atr);

      if ((this.config as any).sendWebhook) await this.postWebhook(signal.signal === 'buy' ? 'BUY' : 'SELL', qty);

    } catch (err) {
      console.error('[MNQDeltaTrend][INTRA-BAR ORDER] execution failed:', err);
      if (this.enteredBarStartMs === barGate) this.enteredBarStartMs = null;
    } finally {
      this.isEnteringPosition = false;
    }
  }

  private closeBarAndProcess(): void {
    if (this.barStartMs === null || this.barOpenPx === null || this.barHighPx === null || this.barLowPx === null) return;

    const contractId = this.contractId;
    const closePx = this.lastPriceByContract.get(contractId);
    if (!Number.isFinite(closePx)) return;

    const volume = Math.max(0, Math.floor(this.volInBarByContract.get(contractId) ?? 0));
    const signed = Math.trunc(this.signedVolInBarByContract.get(contractId) ?? 0);

    const barEndIso = new Date(this.barStartMs + this.barStepMs - 1).toISOString();

    const closedBar: BarData = {
      timestamp: barEndIso,
      open: this.barOpenPx!,
      high: this.barHighPx!,
      low: this.barLowPx!,
      close: closePx!,
      volume,
      delta: signed,
    };

    // Reset accumulators for next bar
    this.volInBarByContract.set(contractId, 0);
    this.signedVolInBarByContract.set(contractId, 0);

    // Process bar-close signal
    const signal = this.calculator.processNewBar(closedBar as any, this.marketState as any);
    void this.handleSignal(signal, closedBar);

    console.debug(`[MNQDeltaTrend][barClose] t=${closedBar.timestamp} O:${closedBar.open} H:${closedBar.high} L:${closedBar.low} C:${closedBar.close} Δ:${closedBar.delta} V:${closedBar.volume}`);

    this.barOpenPx = closePx!;
    this.barHighPx = closePx!;
    this.barLowPx = closePx!;
  }

  private async handleSignal(
    signal: { signal: 'buy' | 'sell' | 'hold'; reason: string; confidence: number },
    bar: BarData
  ) {
    if (signal.signal === 'hold') return;

    // Hard block if entry or flatten in-flight
    if (this.isEnteringPosition || this.isFlattening) return;

    // Don't add to position
    if (this.calculator.hasPosition()) return;

    // If we scratched intrabar and are flat, allow bar-close to re-enter; otherwise block same-bar overlap
    if (this.enteredBarStartMs === this.barStartMs && (this.isEnteringPosition || this.calculator.hasPosition())) return;

    // ATR gate
    const minAtr = Math.max(0, this.config.minAtrToTrade ?? 0);
    const atrNow = this.marketState.atr ?? 0;
    if (!Number.isFinite(atrNow) || atrNow < minAtr) return;

    const direction = signal.signal === 'buy' ? 'long' : 'short';
    const qty = Math.max(1, this.config.contractQuantity ?? 1);

    // Pre-mark the bar to block intrabar overlap; rollback on failure
    const barGate = this.barStartMs;
    this.enteredBarStartMs = barGate;

    try {
      await this.client.createOrder({
        contractId: this.contractId,
        type: 2,
        side: signal.signal === 'buy' ? 0 : 1,
        size: qty,
      });

      this.calculator.setPosition(bar.close, direction, atrNow);

      if ((this.config as any).sendWebhook) this.postWebhook(signal.signal === 'buy' ? 'BUY' : 'SELL', qty);

    } catch (err) {
      console.error('[MNQDeltaTrend][order] placement failed:', err);
      if (this.enteredBarStartMs === barGate) this.enteredBarStartMs = null;
    }
  }
}