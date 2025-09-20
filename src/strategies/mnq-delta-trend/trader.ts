// src/strategies/mnq-delta-trend/trader.ts
import { ProjectXClient } from '../../services/projectx-client';
import { MNQDeltaTrendCalculator } from './calculator';
import { StrategyConfig } from './types'; // uses your local MNQ types
import { GatewayQuote, BarData } from '../../types'; // SignalR types come from global app types

export class MNQDeltaTrendTrader {
  private client: ProjectXClient;
  private calculator: MNQDeltaTrendCalculator;
  private readonly config: StrategyConfig;  

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
  // Pyramiding / race guards
  private exitingNow = false;         // already in your file if you added earlier
  private localOpenQty = 0;           // optimistic local net qty (blocks new entries)
  private entryCooldownUntil = 0;     // ms timestamp to delay re-entry after a flatten
  private sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }
  
  // Minimal market state; calculator maintains ATR/HTF internally after warm-up
  private marketState = {
    atr: 0,
    higherTimeframeTrend: 'neutral' as 'bullish' | 'bearish' | 'neutral',
    deltaCumulative: 0
  };

  // Keep a bound handler so we can remove/ignore as needed
  private marketDataHandler = (q: GatewayQuote & { contractId: string }) => this.onQuote(q);

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

    console.info('[MNQDeltaTrend][Config:Trader]', this.config);
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

    // Log the *exact* effective config the calculator will trade with
    const eff = this.calculator.getConfig()
    console.info('[MNQDeltaTrend][CONFIG:start]', {
      hash: (eff ? (/* reuse same hash impl here or inline: */ 
        (() => {
          const s = JSON.stringify(eff, Object.keys(eff).sort());
          let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
          return (h >>> 0).toString(16).padStart(8, '0');
        })()
      ) : '----'),
      effective: eff
    });
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

  private async onQuote(quote: GatewayQuote & { contractId: string }): Promise<void> {
    if (!this.running) return;
    if (quote.contractId !== this.contractId) return;

    const contractId = quote.contractId;
    const px = quote.lastPrice;
    if (!Number.isFinite(px)) return;

    // Reconcile: calc says flat but we hold a local lock → sync with broker
    if (!this.calculator.hasPosition() && this.localOpenQty > 0 && !this.exitingNow) {
      try {
        const net = await this.client.getNetPositionSize(this.contractId);
        if (Math.abs(net) === 0) {
          // Do NOT unlock on an unconfirmed “flat” snapshot (polls can lag/429).
          console.warn('[MNQDeltaTrend][RECONCILE] broker reports flat (unconfirmed); keeping local lock');
          // no-op: keep this.localOpenQty as-is
        } else {
          // Broker shows open qty → flatten now with one-shot flatten API
          console.warn('[MNQDeltaTrend][RECONCILE] broker shows open qty; flattening', { net });
          this.exitingNow = true;
          try {
            await this.client.closePosition(this.contractId);
            this.localOpenQty = 0;
          } finally {
            this.exitingNow = false;
          }
        }
      } catch (e) {
        console.error('[MNQDeltaTrend][RECONCILE] failed:', e as any);
        // keep lock on error
      }
    }

    // ---- Intrabar protective stop / trailing stop check (tick-level) ----
    if (this.calculator.hasPosition()) {
      const hit = this.calculator.onTickForProtectiveStops(px, this.marketState.atr ?? NaN);
      if (hit === 'hitStop' || hit === 'hitTrail') {
        console.info(
          '[MNQDeltaTrend][EXIT]',
          hit === 'hitStop' ? 'stop hit (tick)' : 'trail hit (tick)',
          {
            px,
            stop:  (this as any).calculator?.['currentPosition']?.stopLoss,
            trail: (this as any).calculator?.['trailingStopLevel']
          }
        );

        // Robust flatten: single broker flatten; avoid quantity loops/spam
        this.exitingNow = true;
        try {
          await this.client.closePosition(this.contractId);   // one-shot flatten
          console.info('[MNQDeltaTrend][EXIT] flattened via closePosition');
          // Clear calc & local locks, add brief cooldown
          this.calculator.clearPosition();
          this.localOpenQty = 0;
          const cdMs = (this.config as any)?.entryCooldownMs ?? 8000;
          this.entryCooldownUntil = Date.now() + cdMs;
        } catch (err) {
          console.error('[MNQDeltaTrend][EXIT] flatten failed:', err as any);
          // keep lock; cooldown briefly to prevent re-entry churn after failure
          this.entryCooldownUntil = Date.now() + 10000;
        } finally {
          this.exitingNow = false;
        }

        // Don’t use this tick for bar building after exit
        return;
      }
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
    if (this.barLowPx !== null)  this.barLowPx  = Math.min(this.barLowPx,  px);
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
    if (signal.signal === 'hold') return;

    const posDir = this.calculator.getPositionDirection();
    const isExitOfLong  = posDir === 'long'  && signal.signal === 'sell';
    const isExitOfShort = posDir === 'short' && signal.signal === 'buy';

    // ---------- EXIT (flatten, do not reverse) ----------
    if (isExitOfLong || isExitOfShort) {
      console.info('[MNQDeltaTrend][EXIT] flattening', { posDir, reason: signal.reason });
      this.exitingNow = true;
      try {
        await this.client.closePosition(this.contractId);   // one-shot flatten
        this.calculator.clearPosition();
        this.localOpenQty = 0;
        const cdMs = (this.config as any)?.entryCooldownMs ?? 8000;
        this.entryCooldownUntil = Date.now() + cdMs;
      } catch (err) {
        console.error('[MNQDeltaTrend][EXIT] flatten failed:', err as any);
        // keep lock; cooldown to prevent immediate churn
        this.entryCooldownUntil = Date.now() + 10000;
      } finally {
        this.exitingNow = false;
      }
      return;
    }

    // ---------- ENTRY (no pyramiding) ----------
    // cooldown after a flatten
    if (Date.now() < this.entryCooldownUntil) {
      console.info('[MNQDeltaTrend][entry-blocked]', { reason: 'cooldown', msLeft: this.entryCooldownUntil - Date.now() });
      return;
    }

    // local locks / in-flight exit / already have position
    if (this.exitingNow || this.localOpenQty !== 0 || this.calculator.hasPosition()) {
      console.info('[MNQDeltaTrend][entry-blocked]', {
        reason: 'pyramiding/local-lock',
        exitingNow: this.exitingNow,
        localOpenQty: this.localOpenQty,
        hasPos: this.calculator.hasPosition()
      });
      return;
    }

    // broker truth (defensive)
    const netOpen = await this.client.getNetPositionSize(this.contractId);
    if (Math.abs(netOpen) > 0) {
      console.info('[MNQDeltaTrend][entry-blocked]', { reason: 'broker shows open qty', netOpen });
      return;
    }

    // if somehow signal matches current dir (shouldn't happen due to guards), ignore
    if (posDir && ((posDir === 'long' && signal.signal === 'buy') || (posDir === 'short' && signal.signal === 'sell'))) {
      console.info('[MNQDeltaTrend][entry-ignored]', { reason: 'already in same direction', posDir });
      return;
    }

    // place entry
    const direction = signal.signal === 'buy' ? 'long' : 'short';
    const atr = this.marketState.atr ?? 0;
    const acctBal = await this.client.getEquity();
    const qty = Math.max(1, this.calculator.calculatePositionSize(bar.close, atr, acctBal));

    console.info(`[MNQDeltaTrend][ENTRY] ${signal.signal.toUpperCase()} qty=${qty} reason="${signal.reason}"`);

    // optimistic lock before sending to broker
    this.localOpenQty = qty;

    try {
      await this.client.createOrder({
        contractId: this.contractId,
        type: 2,                               // Market per Topstep docs
        side: signal.signal === 'buy' ? 0 : 1, // 0=Buy, 1=Sell
        size: qty,
      });

      console.info('[MNQDeltaTrend][ENTRY:broker-ok]', {
        side: signal.signal,
        qty,
        entryPrice: bar.close
      });

      // seed trailing/position state
      try { (this.calculator as any).setPosition?.(bar.close, direction, atr); } catch {}

    } catch (err) {
      // release lock on failure
      this.localOpenQty = 0;
      console.error('[MNQDeltaTrend][ENTRY] placement failed:', err);
    }
  }
}
