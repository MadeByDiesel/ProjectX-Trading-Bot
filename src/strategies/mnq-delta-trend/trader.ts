// src/strategies/mnq-delta-trend/trader.ts
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
  private deltaHistory: Array<{ value: number; timestamp: number }> = [];
  private accelCountL = 0;  // NEW
  private accelCountS = 0;  // NEW

  // --- NEW: flatten & webhook dedupe + broker throttling ---
  private lastFlatAtMs = 0;
  private flatCooldownMs = 1500; // 1.5s single-flight window

  private lastWebhookAt: Record<'BUY'|'SELL'|'FLAT', number> = { BUY: 0, SELL: 0, FLAT: 0 };
  private webhookMinGapMs = 800; // dedupe same webhook within this gap

  private equityCache = { ts: 0, val: 0 };
  private equityTtlMs = 4000;     // cache equity 4s
  private backoffUntilMs = 0;     // broker 429 backoff

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

  /** Post trade events to the local NT8 webhook listener */
  private async postWebhook(action: 'BUY' | 'SELL' | 'FLAT', qty?: number): Promise<void> {
    if (!this.config?.sendWebhook) return;

    // --- NEW: dedupe identical webhook within a short gap ---
    const now = Date.now();
    if (now - this.lastWebhookAt[action] < this.webhookMinGapMs) return;
    this.lastWebhookAt[action] = now;

    const base = this.config.webhookUrl || '';
    if (!base) return;

    const secret = (this as any).config?.webhookSecret;
    const url = (!base.includes('?') && secret) ? `${base}?secret=${secret}` : base;

    const payload: Record<string, any> = { symbol: 'MNQ', action };
    if (action !== 'FLAT') payload.qty = Math.max(1, Number(qty ?? 1));

    const body = JSON.stringify(payload);
    const localIf = (this as any).config?.webhookInterface || '192.168.4.50';

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

    const opts: ExecFileOptionsWithStringEncoding = {
      timeout: 4000,
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

  // --- NEW: broker-safe equity fetch with cache & backoff ---
  private async getEquitySafe(): Promise<number> {
    const now = Date.now();
    if (now < this.backoffUntilMs) throw new Error('broker-backoff');

    if (now - this.equityCache.ts < this.equityTtlMs && this.equityCache.val > 0) {
      return this.equityCache.val;
    }

    const eq = await this.client.getEquity(); // may throw / 429 upstream
    this.equityCache = { ts: now, val: Number(eq) || 0 };
    return this.equityCache.val;
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
      console.debug(`[MNQDeltaTrend][onQuote:first] ${this.symbol} px=${px}, vol=${quote.volume}`);
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

    // Tick-level protective exits (stop/trail)
    // if (this.calculator.hasPosition() && !this.isFlattening) {
    //   const hit = this.calculator.onTickForProtectiveStops(px, this.marketState.atr ?? 0);
    //   if (hit === 'hitStop' || hit === 'hitTrail') {
    //     const dir = this.calculator.getPositionDirection();
    //     console.info(
    //       `[MNQDeltaTrend][EXIT] ${hit} (tick) { px: ${px}, atr: ${this.marketState.atr}, dir: ${dir} }`
    //     );

    //     this.isFlattening = true;
    //     this.client.closePosition(this.contractId)
    //       .then(() => {
    //         console.info('[MNQDeltaTrend][EXIT] flattened via closePosition');
    //         this.calculator.clearPosition();
    //         this.isFlattening = false;

    //         if (this.config.sendWebhook) {
    //           this.postWebhook('FLAT');
    //         }
    //       })
    //       .catch((err) => {
    //         console.error('[MNQDeltaTrend][EXIT] flatten failed:', err);
    //         this.isFlattening = false;
    //       });
    //   }
    // }
    if (this.calculator.hasPosition()) {
      const hit = this.calculator.onTickForProtectiveStops(px, this.marketState.atr ?? 0);
      if (hit === 'hitStop' || hit === 'hitTrail') {
        const now = Date.now();
        // --- NEW: single-flight & cooldown guard ---
        if (this.isFlattening || (now - this.lastFlatAtMs) < this.flatCooldownMs) return;

        this.isFlattening = true;
        this.lastFlatAtMs = now;

        const dir = this.calculator.getPositionDirection();
        console.info(
          `[MNQDeltaTrend][EXIT] ${hit} (tick) { px: ${px}, atr: ${this.marketState.atr}, dir: ${dir} }`
        );

        // --- NEW: timeout race to avoid hanging ---
        const closeP = this.client.closePosition(this.contractId);
        const timeoutP = new Promise<void>((_, rej) => setTimeout(() => rej(new Error('flatten-timeout')), 2500));

        Promise.race([closeP, timeoutP])
          .then(() => {
            console.info('[MNQDeltaTrend][EXIT] flattened via closePosition');
            this.calculator.clearPosition();
            if (this.config.sendWebhook) this.postWebhook('FLAT');
          })
          .catch((err) => {
            console.error('[MNQDeltaTrend][EXIT] flatten failed/timeout:', err?.message ?? err);
            // Clear local state to avoid repeated FLAT storms in chop
            try { this.calculator.clearPosition(); } catch {}
          })
          .finally(() => {
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
      // Crossed into new bucket → close prior bar and open new one
      this.closeBarAndProcess();
      
      this.barStartMs = bucketStart;
      this.barOpenPx = px;
      this.barHighPx = px;
      this.barLowPx = px;
      
      // Reset live bar tracking for new bar
      this.liveBarOpen = px;
      this.liveBarHigh = px;
      this.liveBarLow = px;
      this.liveBarStartMs = nowMs;
      this.lastIntraBarCheckMs = 0;
      
      // Reset per-bar entry tracking
      this.enteredBarStartMs = null;
      
      // Reset calculator's intra-bar tracking
      this.calculator.resetIntraBarTracking();
      this.deltaHistory = []; // ADD HERE
      this.accelCountL = 0;   // NEW
      this.accelCountS = 0;   // NEW
      
      console.debug(`[MNQDeltaTrend][barOpen] ${new Date(this.barStartMs).toISOString()} O=${px}`);
      return;
    }

    // Update current bar extremes
    if (this.barHighPx !== null) this.barHighPx = Math.max(this.barHighPx, px);
    if (this.barLowPx !== null) this.barLowPx = Math.min(this.barLowPx, px);
    if (this.liveBarHigh !== null) this.liveBarHigh = Math.max(this.liveBarHigh, px);
    if (this.liveBarLow !== null) this.liveBarLow = Math.min(this.liveBarLow, px);

    // Intra-bar delta signal check
    if (this.config.useIntraBarDetection && !this.calculator.hasPosition() && !this.isFlattening) {
      const checkIntervalMs = this.config.intraBarCheckIntervalMs ?? 100;
      
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
      
      this.liveBarOpen = lastPx!;
      this.liveBarHigh = lastPx!;
      this.liveBarLow = lastPx!;
      this.liveBarStartMs = nowMs;
      this.lastIntraBarCheckMs = 0;
      
      // Reset per-bar entry tracking
      this.enteredBarStartMs = null;
      
      this.calculator.resetIntraBarTracking();
      this.deltaHistory = []; // ADD HERE
      this.accelCountL = 0;   // NEW
      this.accelCountS = 0;   // NEW
      
      console.debug(`[MNQDeltaTrend][barOpen:HB] ${new Date(this.barStartMs).toISOString()} O=${lastPx}`);
    }
  }

  /**
   * Check for intra-bar signal generation based on accumulating delta.
   */
  private checkIntraBarSignal(currentPrice: number, nowMs: number): void {
    if (!this.liveBarOpen || !this.liveBarHigh || !this.liveBarLow || !this.liveBarStartMs) {
      return;
    }

    // Per-bar entry limit
    if (this.enteredBarStartMs === this.barStartMs) {
      return;
    }

    const accumulationTimeMs = nowMs - this.liveBarStartMs;
    const currentDelta = this.signedVolInBarByContract.get(this.contractId) ?? 0;
    const currentVolume = this.volInBarByContract.get(this.contractId) ?? 0;

    // === DELTA ACCELERATION FILTER (FINAL) ===
    // 1) push current directional sample FIRST
    this.deltaHistory.push({ value: currentDelta, timestamp: nowMs });
    // 2) keep last ~1.2s / 5 points
    this.deltaHistory = this.deltaHistory
      .filter(e => (nowMs - e.timestamp) <= 1200)
      .slice(-5);

    // need ≥3 points
    if (this.deltaHistory.length < 3) return;

    const p2 = this.deltaHistory[this.deltaHistory.length - 3];
    const p1 = this.deltaHistory[this.deltaHistory.length - 2];
    const p0 = this.deltaHistory[this.deltaHistory.length - 1];

    const dt1s = Math.max(0.10, (p1.timestamp - p2.timestamp) / 1000);
    const dt0s = Math.max(0.10, (p0.timestamp - p1.timestamp) / 1000);

    const v1 = (p1.value - p2.value) / dt1s; // delta/sec
    const v0 = (p0.value - p1.value) / dt0s; // delta/sec
    const a  = v0 - v1;                      // delta/sec^2

    const MIN_VEL = 300;
    const HYST    = 50;

    let accelOkLong  = (v0 >  MIN_VEL) && (a >  HYST);
    let accelOkShort = (v0 < -MIN_VEL) && (a < -HYST);

    // stickiness: require ≥2 consecutive passes
    this.accelCountL = accelOkLong  ? this.accelCountL + 1 : 0;
    this.accelCountS = accelOkShort ? this.accelCountS + 1 : 0;
    accelOkLong  = this.accelCountL >= 2;
    accelOkShort = this.accelCountS >= 2;
    // === END DELTA ACCELERATION FILTER ===

    const formingBar: BarData = {
      timestamp: new Date(this.barStartMs!).toISOString(),
      open: this.liveBarOpen,
      high: this.liveBarHigh,
      low: this.liveBarLow,
      close: currentPrice,
      volume: currentVolume,
      delta: currentDelta,
    };

    const signal = this.calculator.evaluateFormingBar(
      formingBar,
      this.marketState as any,
      accumulationTimeMs
    );

    // Align accel filter with decided side
    if ((signal.signal === 'buy'  && !accelOkLong) ||
        (signal.signal === 'sell' && !accelOkShort)) {
      return;
    }
    
    if (signal.signal === 'buy' || signal.signal === 'sell') {
      console.info(
        `[MNQDeltaTrend][INTRA-BAR SIGNAL] ${signal.signal.toUpperCase()}`,
        `Δ=${currentDelta.toFixed(0)} px=${currentPrice.toFixed(2)}`,
        `accumulated=${accumulationTimeMs}ms reason="${signal.reason}"`
      );
      
      void this.executeIntraBarSignal(signal, formingBar);
    }
  }

  /**
   * Execute order from intra-bar signal.
   */
  private async executeIntraBarSignal(
    signal: { signal: 'buy' | 'sell' | 'hold'; reason: string; confidence: number },
    bar: BarData
  ): Promise<void> {
    if (signal.signal === 'hold') return;
    if (this.calculator.hasPosition()) return;
    if (this.isFlattening) return;

    // Async execution lock
    if (this.isEnteringPosition) {
      console.debug('[MNQDeltaTrend][INTRA-BAR] Entry already in progress, skipping');
      return;
    }

    // Double-check per-bar limit (race condition guard)
    if (this.enteredBarStartMs === this.barStartMs) {
      console.debug('[MNQDeltaTrend][INTRA-BAR] Already entered this bar, skipping');
      return;
    }

    this.isEnteringPosition = true;

    try {
      const direction = signal.signal === 'buy' ? 'long' : 'short';
      const atr = this.marketState.atr ?? 0;

      let qty = 1;

      try {
        const acctBal = await this.getEquitySafe();
        qty = Math.max(1, this.calculator.calculatePositionSize(bar.close, atr, acctBal));

        console.info(
          `[MNQDeltaTrend][INTRA-BAR ORDER] ${signal.signal.toUpperCase()} qty=${qty}`,
          `confidence=${signal.confidence} bar=${new Date(this.barStartMs!).toISOString()}`
        );

        await this.client.createOrder({
          contractId: this.contractId,
          type: 2,
          side: signal.signal === 'buy' ? 0 : 1,
          size: qty,
        });
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (msg.includes('429') || msg.includes('backoff')) {
          this.backoffUntilMs = Date.now() + 4000; // NEW: quiet period after rate-limit
          console.warn('[rate-limit] backing off until', new Date(this.backoffUntilMs).toISOString());
        }
        // --- NEW: DO NOT retry this bar; keep the per-bar lock to avoid storms
        this.enteredBarStartMs = this.barStartMs;
        console.error('[MNQDeltaTrend][order] placement failed:', err);
        return; // <-- swallow here since caller used `void`
      }     
 
      // Mark this bar as entered
      this.enteredBarStartMs = this.barStartMs;

      try {
        (this.calculator as any).setPosition?.(bar.close, direction, atr);
      } catch (err) {
        console.warn('[MNQDeltaTrend][INTRA-BAR] setPosition failed:', err);
      }

      if (this.config.sendWebhook) {
        await this.postWebhook(signal.signal === 'buy' ? 'BUY' : 'SELL', qty);
      }

    // } catch (err) {
    //   console.error('[MNQDeltaTrend][INTRA-BAR ORDER] execution failed:', err);
    //   // If order failed, allow retry on this bar
    //   this.enteredBarStartMs = null;
    // } finally {
    } catch (err) {
      console.error('[MNQDeltaTrend][INTRA-BAR ORDER] execution failed:', err);
      // NEW: keep lock — no same-bar retry (prevents bursts & 429s)
      this.enteredBarStartMs = this.barStartMs;
    } finally {    
      this.isEnteringPosition = false;
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

    const barEndIso = new Date(this.barStartMs + this.barStepMs - 1).toISOString();

    const closedBar: BarData = {
      timestamp: barEndIso,
      open: this.barOpenPx,
      high: this.barHighPx,
      low: this.barLowPx,
      close: closePx!,
      volume: volume,
      delta: signed,
    };

    // Reset accumulators for next bar
    this.volInBarByContract.set(contractId, 0);
    this.signedVolInBarByContract.set(contractId, 0);

    // Process bar-close signal (fallback if intra-bar didn't fire)
    const signal = this.calculator.processNewBar(closedBar as any, this.marketState as any);
    // Skip bar-close entries when intra-bar detection is on
    if (this.config.useIntraBarDetection && this.config.disableBarCloseEntries !== false) {
      console.debug('[MNQDeltaTrend][barClose] intra-bar enabled → skip bar-close entries');
    } else {
      void this.handleSignal(signal, closedBar);
    }

    console.debug(
      `[MNQDeltaTrend][barClose] t=${closedBar.timestamp} O:${closedBar.open} H:${closedBar.high} L:${closedBar.low} C:${closedBar.close} Δ:${closedBar.delta} V:${closedBar.volume}`
    );

    this.barOpenPx = closePx!;
    this.barHighPx = closePx!;
    this.barLowPx = closePx!;
  }

  private async handleSignal(
    signal: { signal: 'buy' | 'sell' | 'hold'; reason: string; confidence: number },
    bar: BarData
  ) {
    if (signal.signal === 'hold') {
      console.debug('[MNQDeltaTrend][order] HOLD:', signal.reason);
      return;
    }

    // Don't add to position
    if (this.calculator.hasPosition()) {
      if (signal.signal === 'buy' || signal.signal === 'sell') {
        console.debug('[MNQDeltaTrend][order] skipped: already in position');
        return;
      }
    }

    // Per-bar entry limit for bar-close signals too
    if (this.enteredBarStartMs === this.barStartMs) {
      console.debug('[MNQDeltaTrend][order] skipped: already entered this bar (intra-bar signal fired)');
      return;
    }

    // Enforce ATR gate
    const minAtr = Math.max(0, this.config.minAtrToTrade ?? 0);
    const atrNow = this.marketState.atr ?? 0;
    if (!Number.isFinite(atrNow) || atrNow < minAtr) {
      console.debug(
        `[MNQDeltaTrend][order] blocked: ATR gate failed (atr=${atrNow}, thresh=${minAtr})`
      );
      return;
    }

    //   // Mark bar as entered
    //   this.enteredBarStartMs = this.barStartMs;
      const direction = signal.signal === 'buy' ? 'long' : 'short';
      const atr = this.marketState.atr ?? 0;

      let qty = 1;
      try {
        const acctBal = await this.getEquitySafe();
        qty = Math.max(1, this.calculator.calculatePositionSize(bar.close, atr, acctBal));

        console.info(`[MNQDeltaTrend][order] ${signal.signal.toUpperCase()} qty=${qty} reason="${signal.reason}"`);

        await this.client.createOrder({
          contractId: this.contractId,
          type: 2,
          side: signal.signal === 'buy' ? 0 : 1,
          size: qty,
        });

        // Mark bar as entered
        this.enteredBarStartMs = this.barStartMs;

      } catch (err: any) {
        const msg = String(err?.message || err);
        if (msg.includes('429') || msg.includes('backoff')) {
          this.backoffUntilMs = Date.now() + 4000;
          console.warn('[rate-limit] backing off until', new Date(this.backoffUntilMs).toISOString());
        }
        // Do not retry same bar
        this.enteredBarStartMs = this.barStartMs;
        throw err;
      }
      try {
        (this.calculator as any).setPosition?.(bar.close, direction, atr);
      } catch {}

      if (this.config.sendWebhook) {
        this.postWebhook(signal.signal === 'buy' ? 'BUY' : 'SELL', qty);
      }


  }
}