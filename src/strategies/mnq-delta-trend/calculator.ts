// src/strategies/mnq-delta-trend/calculator.ts
import { BarData, MarketState, StrategyConfig, TradeSignal } from './types';
import { TechnicalCalculator } from '../../utils/technical';

console.log('[calc] loaded', __filename);


export class MNQDeltaTrendCalculator {
  private readonly config: Readonly<StrategyConfig>;
  private technical: TechnicalCalculator;

  // Closed bars storage
  private bars3min: BarData[] = [];   // LTF = 3m
  private bars15min: BarData[] = [];  // HTF container (name kept for clarity)

  private isWarmUpProcessed = false;

  // Position / trailing
  private currentPosition: {
    entryPrice: number;
    entryTime: number;
    direction: 'long' | 'short';
    stopLoss: number;
  } | null = null;

  private trailingStopLevel = 0;
  private trailArmed = false;
  private noTrailBeforeMs = 0;

  // Track HTF bucket to avoid duplicate/new-bar mistakes when aggregating from 3m
  private lastHTFBucketStartMs: number | null = null;

  // constructor (ensure this exists)
  constructor(config: StrategyConfig) {
    this.config = Object.freeze(JSON.parse(JSON.stringify(config)));
    this.technical = new TechnicalCalculator();
    console.info('[MNQDeltaTrend][Config:Calculator]', this.config);
  }

  // add this method anywhere in the class
  public getConfig(): Readonly<StrategyConfig> {
    return this.config;
  }
  
  /** Warm-up loader: push bars as given (already closed) */
  processWarmUpBar(bar: BarData, timeframe: '3min' | 'HTF'): void {
    // Ensure delta present (fallback: price change if not provided)
    const normalized: BarData = {
      ...bar,
      delta: typeof bar.delta === 'number' && Number.isFinite(bar.delta)
        ? bar.delta
        : Number((bar.close - bar.open).toFixed(2)),
    };

    const arr = timeframe === '3min' ? this.bars3min : this.bars15min;
    arr.push(normalized);
    if (timeframe === '3min' && this.bars3min.length > 2000) this.bars3min.shift();
    if (timeframe === 'HTF' && this.bars15min.length > 1000) this.bars15min.shift();
  }

  /** Trader calls this once warm-up loads are done */
  completeWarmUp(): void {
    this.isWarmUpProcessed = true;
    if (this.bars3min.length > 0 || this.bars15min.length > 0) {
      // prime indicators
      void this.calculateATR();
      void this.determineTrend();
    }
  }

  /**
   * Main entry: receives a **closed 3-minute bar**.
   */
  processNewBar(incoming: BarData, marketState: MarketState): TradeSignal {
    if (!this.isWarmUpProcessed) {
      return { signal: 'hold', reason: 'Warm-up in progress', confidence: 0 };
    }

    // Normalize delta if missing
    const bar: BarData = {
      ...incoming,
      delta: typeof incoming.delta === 'number' && Number.isFinite(incoming.delta)
        ? Math.trunc(incoming.delta) // keep integer parity vs signed vol
        : Number((incoming.close - incoming.open).toFixed(2)),
    };

    // Append closed LTF bar
    this.bars3min.push(bar);
    if (this.bars3min.length > 2000) this.bars3min.shift();

    // Build/merge HTF from this closed LTF bar
    this.updateHigherTimeframeBars(bar);

    // --- Indicators computed on closed bars ---
    const atr = this.calculateATR();
    const trend = this.determineTrend();
    const { brokeUpCloseTol, brokeDownCloseTol, rangeHighTol, rangeLowTol } = this.checkBreakoutCloseTol();
    const { ltfEmaPass } = this.checkLtfEmaFilter();

    // Update market state snapshot for the trader
    marketState.atr = Number.isFinite(atr) ? atr : 0;
    marketState.higherTimeframeTrend = trend;
    marketState.deltaCumulative = (marketState.deltaCumulative ?? 0) + (bar.delta ?? 0);

    // Exits first (bar-close exits)
    const exitSignal = this.checkExitConditions(bar, marketState);
    if (exitSignal) return exitSignal;

    // Entries next
    return this.generateSignal(bar, marketState, {
      brokeUpCloseTol,
      brokeDownCloseTol,
      ltfEmaPass
    });
  }

  // ---------------- HTF aggregation from closed LTF bars ----------------

  private updateHigherTimeframeBars(bar: BarData): void {
    const htfMin = Math.max(1, Number((this.config as any).higherTimeframe ?? 15)); // tolerate string
    const stepMs = htfMin * 60 * 1000;
    const tsMs = Date.parse(bar.timestamp);
    const bucketStartMs = Math.floor(tsMs / stepMs) * stepMs;

    const last = this.bars15min[this.bars15min.length - 1];

    // Start a new HTF bar when we move into a new HTF bucket
    if (!last || this.lastHTFBucketStartMs === null || bucketStartMs > this.lastHTFBucketStartMs) {
      this.bars15min.push({ ...bar });
      this.lastHTFBucketStartMs = bucketStartMs;
      if (this.bars15min.length > 1000) this.bars15min.shift();
      return;
    }

    // Merge into the current open HTF bar
    last.high = Math.max(last.high, bar.high);
    last.low = Math.min(last.low, bar.low);
    last.close = bar.close;
    last.volume = (last.volume ?? 0) + (bar.volume ?? 0);
    if (typeof bar.delta === 'number') last.delta = (last.delta ?? 0) + bar.delta;
  }

  // ---------------- Indicators ----------------

  private calculateATR(): number {
    const period = 14;

    // Need at least some history to try; if too short, bail like Pine would
    if (this.bars3min.length < period + 1) return NaN;

    // Helper: coerce to finite numbers or return null to skip
    const norm = (v: unknown): number | null => {
      const n = typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v) : NaN);
      return Number.isFinite(n) ? n : null;
    };

    // Build a *contiguous* tail of valid bars (O/H/L/C all finite), walking backward,
    // then reverse back to chronological order. We want at least period+1 bars.
    const needed = period + 1;
    const validTail: Array<{ open: number; high: number; low: number; close: number }> = [];

    for (let i = this.bars3min.length - 1; i >= 0 && validTail.length < needed; i--) {
      const b = this.bars3min[i];
      const o = norm(b.open);
      const h = norm(b.high);
      const l = norm(b.low);
      const c = norm(b.close);
      if (o !== null && h !== null && l !== null && c !== null) {
        // prepend later; for now, push and we'll reverse
        validTail.push({ open: o, high: h, low: l, close: c });
      } else {
        // If we hit an invalid bar inside the needed window, keep walking back to
        // fill enough *valid* bars. (We do not break; we just skip this bar.)
        continue;
      }
    }

    if (validTail.length < needed) {
      // Not enough clean bars to compute ATR
      console.warn('[MNQDeltaTrend][ATR] insufficient valid bars', {
        have: validTail.length,
        need: needed,
        totalBars: this.bars3min.length
      });
      return NaN;
    }

    // Chronological order: oldest -> newest
    validTail.reverse();

    // Wilder TR series over consecutive bars (uses prev close)
    const tr: number[] = [];
    for (let i = 1; i < validTail.length; i++) {
      const h = validTail[i].high;
      const l = validTail[i].low;
      const prevC = validTail[i - 1].close;
      const trVal = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
      tr.push(trVal);
    }

    if (tr.length < period) return NaN;

    // Seed ATR = simple average of first `period` TRs
    let atr = 0;
    for (let i = 0; i < period; i++) atr += tr[i];
    atr /= period;

    // Wilder smoothing for the remainder (if any)
    for (let i = period; i < tr.length; i++) {
      atr = (atr * (period - 1) + tr[i]) / period;
    }

    if (!Number.isFinite(atr) || atr <= 0) {
      console.warn('[MNQDeltaTrend][ATR] computed non-finite/<=0', { atr });
      return NaN;
    }

    // Helpful one-liner to see we’re good
    console.debug('[MNQDeltaTrend][ATR]', { method: 'sanitized', atr });

    return atr;
  }
  
  private checkLtfEmaFilter(): { ltfEmaPass: boolean } {
    if (!this.config.useEmaFilter) return { ltfEmaPass: true };
    const L = Math.max(1, this.config.emaLength ?? 21);
    const closes = this.bars3min.map(b => b.close);
    if (closes.length < L) return { ltfEmaPass: false };
    const emaSeries = this.technical.calculateEMA(closes, L);
    const lastClose = closes[closes.length - 1];
    const lastEma = emaSeries[emaSeries.length - 1];
    return { ltfEmaPass: lastClose >= lastEma };
  }

  // private determineTrend(): 'bullish' | 'bearish' | 'neutral' {
  //   // HTF EMA trend
  //   if (this.bars15min.length < 2) return 'neutral';
  //   const L = Math.max(1, this.config.htfEMALength ?? 50);
  //   const closes = this.bars15min.map(b => b.close);
  //   if (closes.length < L) return 'neutral';
  //   const emaSeries = this.technical.calculateEMA(closes, L);
  //   const px = closes[closes.length - 1];
  //   const ema = emaSeries[emaSeries.length - 1];
  //   return px > ema ? 'bullish' : px < ema ? 'bearish' : 'neutral';
  // }

  private determineTrend(): 'bullish' | 'bearish' | 'neutral' {
    // Guard: need at least 2 HTF bars to say anything
    if (this.bars15min.length < 2) return 'neutral';

    const L = Math.max(1, this.config.htfEMALength ?? 50);

    // Decide which HTF bar index to use as "current":
    // - true/undefined -> use the forming bar (last index)
    // - false          -> use only the last fully CLOSED bar (skip forming -> last index - 1)
    const useForming = this.config.htfUseForming !== false; // default true
    const lastIdx = useForming ? (this.bars15min.length - 1) : (this.bars15min.length - 2);

    if (lastIdx < 0) return 'neutral';

    // Build closes up to the chosen index (inclusive)
    const closes = this.bars15min.slice(0, lastIdx + 1).map(b => b.close);
    if (closes.length < L) return 'neutral';

    const emaSeries = this.technical.calculateEMA(closes, L);
    const px = closes[closes.length - 1];
    const ema = emaSeries[emaSeries.length - 1];

    return px > ema ? 'bullish' : px < ema ? 'bearish' : 'neutral';
  }

  /**
   * Breakout vs previous N bars using Pine tolerances on **close**:
   * long: close > rangeHigh * 0.995
   * short: close < rangeLow  * 1.005
   */
  private checkBreakoutCloseTol(): {
    brokeUpCloseTol: boolean;
    brokeDownCloseTol: boolean;
    rangeHighTol: number | null;
    rangeLowTol: number | null;
  } {
    const n = Math.max(1, this.config.breakoutLookbackBars ?? 20);
    if (this.bars3min.length < n + 1) {
      return { brokeUpCloseTol: false, brokeDownCloseTol: false, rangeHighTol: null, rangeLowTol: null };
    }
    const last = this.bars3min[this.bars3min.length - 1];
    const window = this.bars3min.slice(-n - 1, -1); // previous N bars

    const rangeHigh = Math.max(...window.map(b => b.high));
    const rangeLow = Math.min(...window.map(b => b.low));

    const rangeHighTol = rangeHigh * 0.995; // Pine
    const rangeLowTol = rangeLow * 1.005;  // Pine

    return {
      brokeUpCloseTol: last.close > rangeHighTol,
      brokeDownCloseTol: last.close < rangeLowTol,
      rangeHighTol,
      rangeLowTol
    };
  }

  // ---------------- Exits ----------------

  private checkExitConditions(bar: BarData, _marketState: MarketState): TradeSignal | null {
    if (!this.currentPosition) return null;

    const { entryTime, direction, stopLoss } = this.currentPosition;

    // Enforce min bars in trade (on LTF)
    const minBars = Math.max(0, this.config.minBarsBeforeExit ?? 0);
    const barsSinceEntry = this.bars3min.filter(b => new Date(b.timestamp).getTime() > entryTime).length;
    if (barsSinceEntry < minBars) return null;

    // 1) HARD SL on bar close parity
    if (direction === 'long') {
      if (bar.close <= stopLoss) {
        return { signal: 'sell', reason: `Hit stop (${stopLoss.toFixed(2)})`, confidence: 1.0 };
      }
    } else {
      if (bar.close >= stopLoss) {
        return { signal: 'buy', reason: `Hit stop (${stopLoss.toFixed(2)})`, confidence: 1.0 };
      }
    }

    // // 2) Trailing stop (if enabled)
    // if (this.config.useTrailingStop) {
    //   const trail = this.checkTrailingStop(bar, direction);
    //   if (trail) return trail;
    // }

    // 3) Delta slope exit
    const slopeExit = this.checkDeltaSlopeExit(direction);
    if (slopeExit) return slopeExit;

    return null;
  }

  // private checkTrailingStop(bar: BarData, direction: 'long' | 'short'): TradeSignal | null {
  //   if (!this.currentPosition) return null;

  //   const atr = this.calculateATR();
  //   if (!Number.isFinite(atr) || atr <= 0) return null;

  //   const act = atr * (this.config.trailActivationATR ?? 1.5); // activation distance from entry
  //   const off = atr * (this.config.trailOffsetATR ?? 1.0);     // offset from recent close
  //   const { entryPrice } = this.currentPosition;

  //   // Activate trailing only after price moves in our favor by 'act' from ENTRY
  //   if (!this.trailArmed) {
  //     if (direction === 'long') {
  //       if (bar.close - entryPrice >= act) {
  //         this.trailArmed = true;
  //         // Start trail at the better of hard stop and (close - off)
  //         this.trailingStopLevel = Math.max(this.currentPosition.stopLoss, bar.close - off);
  //         // console.debug('[MNQDeltaTrend][trail] activate long', { level: this.trailingStopLevel, act, off });
  //       }
  //     } else {
  //       if (entryPrice - bar.close >= act) {
  //         this.trailArmed = true;
  //         this.trailingStopLevel = Math.min(this.currentPosition.stopLoss, bar.close + off);
  //         // console.debug('[MNQDeltaTrend][trail] activate short', { level: this.trailingStopLevel, act, off });
  //       }
  //     }
  //     return null; // not active yet or just activated (start protecting from next bar)
  //   }

  //   // If active, ratchet only in the favorable direction
  //   if (direction === 'long') {
  //     const newLevel = bar.close - off;
  //     if (newLevel > this.trailingStopLevel) this.trailingStopLevel = newLevel;
  //     // Exit if we close below/equal to trailing (bar-close parity)
  //     if (bar.close <= this.trailingStopLevel) {
  //       return { signal: 'sell', reason: 'Trailing stop hit', confidence: 0.95 };
  //     }
  //   } else {
  //     const newLevel = bar.close + off;
  //     if (newLevel < this.trailingStopLevel) this.trailingStopLevel = newLevel;
  //     if (bar.close >= this.trailingStopLevel) {
  //       return { signal: 'buy', reason: 'Trailing stop hit', confidence: 0.95 };
  //     }
  //   }

  //   return null;
  // }

  /** Tick-level trailing: updates trailingStopLevel on live price and returns true if exit should fire now */
  //   public onTickForTrailing(lastPrice: number, atr: number): boolean {
  //   if (!this.currentPosition) return false;
  //   if (!Number.isFinite(atr) || atr <= 0) return false;

  //   const act = atr * (this.config.trailActivationATR ?? 1.5);
  //   const off = atr * (this.config.trailOffsetATR ?? 1.0);

  //   const dir = this.currentPosition.direction;

  //   if (dir === 'long') {
  //     // lift the stop when we’ve moved act above current trailing level
  //     if (lastPrice > this.trailingStopLevel + act) {
  //       this.trailingStopLevel = lastPrice - off;
  //     }
  //     // fire if price back to or through the trail
  //     return lastPrice <= this.trailingStopLevel;
  //   } else {
  //     if (lastPrice < this.trailingStopLevel - act) {
  //       this.trailingStopLevel = lastPrice + off;
  //     }
  //     return lastPrice >= this.trailingStopLevel;
  //   }
  // }
  
  private checkDeltaSlopeExit(direction: 'long' | 'short'): TradeSignal | null {
    const n = Math.max(1, this.config.deltaSlopeExitLength ?? 5);
    if (this.bars3min.length < n + 1) return null;

    const smaNow = this.smaOfDelta(n, this.bars3min.length - 1);
    const smaPrev = this.smaOfDelta(n, this.bars3min.length - 2);
    if (!Number.isFinite(smaNow) || !Number.isFinite(smaPrev)) return null;

    const slope = smaNow - smaPrev;

    if (direction === 'long' && slope < 0) {
      return { signal: 'sell', reason: 'Delta slope turning negative', confidence: 0.7 };
    }
    if (direction === 'short' && slope > 0) {
      return { signal: 'buy', reason: 'Delta slope turning positive', confidence: 0.7 };
    }
    return null;
  }

  private smaOfDelta(n: number, endIndex: number): number {
    if (endIndex < 0) return NaN;
    const start = Math.max(0, endIndex - n + 1);
    if (endIndex - start + 1 < n) return NaN;
    let sum = 0;
    for (let i = start; i <= endIndex; i++) {
      const d = this.bars3min[i].delta;
      sum += typeof d === 'number' ? d : Number((this.bars3min[i].close - this.bars3min[i].open).toFixed(2));
    }
    return sum / n;
  }

  // ---------------- Entries ----------------

  private generateSignal(
    bar: BarData,
    marketState: MarketState,
    gates: { brokeUpCloseTol: boolean; brokeDownCloseTol: boolean; ltfEmaPass: boolean }
  ): TradeSignal {
    const { brokeUpCloseTol, brokeDownCloseTol, ltfEmaPass } = gates;

    // ATR gate (Pine: atrVal > atrThreshold)
    const atrMin = this.config.minAtrToTrade ?? 0;
    // 👇 Add this line here
    console.log('[ATR gate]', { bars3: this.bars3min.length, atr: marketState.atr, atrMin });
    if (!(Number.isFinite(marketState.atr) && marketState.atr > atrMin)) {
      return { signal: 'hold', reason: 'ATR below threshold', confidence: 0 };
    }

    // Delta spike logic with scale (parity)
    const scale = (this.config as any).deltaScale ?? 1;
    const spike = (this.config.deltaSpikeThreshold ?? 750) * scale;
    // const avgAbsDelta = this.calcAbsDeltaSMA();
    const len = Math.max(1, this.config.deltaSMALength ?? 20);
    let avgAbsDelta = NaN;
    if (this.bars3min.length >= len) {
      const recent = this.bars3min.slice(-len);
      const sumAbs = recent.reduce((s, b) => {
        const d = typeof b.delta === 'number' ? b.delta : (b.close - b.open);
        return s + Math.abs(d);
      }, 0);
      avgAbsDelta = sumAbs / len;
    }
    const surge = Number.isFinite(avgAbsDelta)
      ? avgAbsDelta * (this.config.deltaSurgeMultiplier ?? 1.0)
      : 0;

    const delta = typeof bar.delta === 'number' ? bar.delta : 0;
    const absDelta = Math.abs(delta);

    const passDeltaLong = absDelta > spike && absDelta > surge && delta > 0;
    const passDeltaShort = absDelta > spike && absDelta > surge && delta < 0;

    if (this.config.useEmaFilter && !ltfEmaPass) {
      return { signal: 'hold', reason: 'LTF EMA filter not passed', confidence: 0 };
    }

    // HTF trend
    const htf = marketState.higherTimeframeTrend;
      console.debug('[MNQDeltaTrend][deltaCheck]', {
        delta, absDelta, spike, surge, passDeltaLong, passDeltaShort
      });

    // LONG
    if (passDeltaLong && htf === 'bullish' && brokeUpCloseTol) {
      return {
        signal: 'buy',
        reason: `Delta spike ${delta} > ${spike}, bullish HTF, close>rangeHigh*0.995`,
        confidence: 0.9
      };
    }

    // SHORT
    if (passDeltaShort && htf === 'bearish' && brokeDownCloseTol) {
      return {
        signal: 'sell',
        reason: `Delta spike ${delta} < -${spike}, bearish HTF, close<rangeLow*1.005`,
        confidence: 0.9
      };
    }

    return { signal: 'hold', reason: 'No strong signal', confidence: 0 };
  }

  // ---------------- Sizing/Stops API ----------------

  calculatePositionSize(currentPrice: number, atr: number, accountBalance: number): number {
    void currentPrice; // not used in this sizing model
    const riskAmount = accountBalance * 0.01; // 1% risk per trade
    const riskPerContract = atr * (this.config.atrStopLossMultiplier ?? 1); // per-contract risk proxy
    if (!Number.isFinite(riskPerContract) || riskPerContract <= 0) return 1;
    const size = Math.floor(riskAmount / riskPerContract);
    return Math.min(Math.max(1, size), this.config.contractQuantity ?? 1);
  }

  // ---------------- Position hooks ----------------
  public setPosition(entryPrice: number, direction: 'long' | 'short', atrForTrail?: number): void {
    // choose ATR passed by trader if valid; otherwise compute from local bars
    const atr = (typeof atrForTrail === 'number' && Number.isFinite(atrForTrail) && atrForTrail > 0)
      ? atrForTrail
      : (this.calculateATR() || 0);

    // derive hard stop from ATR
    const slDist = atr * (this.config.atrStopLossMultiplier ?? 1.0);
    const stopLoss = direction === 'long' ? (entryPrice - slDist) : (entryPrice + slDist);

    // store full position state
    this.currentPosition = {
      entryPrice,
      entryTime: Date.now(),
      direction,
      stopLoss,
    };

    // seed trailing (activation handled by trail logic)
    const off = atr * (this.config.trailOffsetATR ?? 1.0);
    this.trailingStopLevel = direction === 'long'
      ? entryPrice - off
      : entryPrice + off;

    this.trailArmed = false;
    this.noTrailBeforeMs = Date.now() + (((this as any).config?.tickExitGraceMs ?? 2000) | 0);

    console.info('[MNQDeltaTrend][ENTRY:init]', {
      dir: direction,
      entry: entryPrice,
      atr,
      stopLoss,
      trailSeed: this.trailingStopLevel,
      trailActivationMove: atr * (this.config.trailActivationATR ?? 1.5)
    });
  }

  public clearPosition(): void {
    this.currentPosition = null;
    this.trailingStopLevel = 0;
    this.trailArmed = false;
  }
  
  public hasPosition(): boolean {
    return !!this.currentPosition;
  }

  public getPositionDirection(): 'long' | 'short' | null {
    return this.currentPosition?.direction ?? null;
  }

  /**
   * Tick-level protective exits (no fixed TP).
   * Returns: 'none' | 'hitStop' | 'hitTrail'
   */
  public onTickForProtectiveStops(lastPrice: number, atrNow: number): 'none' | 'hitStop' | 'hitTrail' {
    if (!this.currentPosition || !Number.isFinite(lastPrice)) return 'none';

    const { direction: dir, entryPrice, stopLoss } = this.currentPosition;

    // Always honor hard SL intrabar
    if (dir === 'long'  && lastPrice <= stopLoss) return 'hitStop';
    if (dir === 'short' && lastPrice >= stopLoss) return 'hitStop';

    // Don’t allow trailing to fire during the initial grace window after entry
    if (Date.now() < this.noTrailBeforeMs) return 'none';

    // Use provided ATR or compute fallback
    const atr = Number.isFinite(atrNow) && atrNow > 0 ? atrNow : this.calculateATR();
    if (!Number.isFinite(atr) || atr <= 0) return 'none';

    const act = atr * (this.config.trailActivationATR ?? 1.5);
    const off = atr * (this.config.trailOffsetATR ?? 1.0);

    // In onTickForProtectiveStops, after const act/off:
    if (dir === 'long') {
      if (this.trailingStopLevel && this.trailingStopLevel < stopLoss) {
        console.warn('[trail-invariant] long: trail < stopLoss; bumping to stopLoss', {
          trail: this.trailingStopLevel, stopLoss
        });
        this.trailingStopLevel = stopLoss;
      }
    } else {
      if (this.trailingStopLevel && this.trailingStopLevel > stopLoss) {
        console.warn('[trail-invariant] short: trail > stopLoss; bumping to stopLoss', {
          trail: this.trailingStopLevel, stopLoss
        });
        this.trailingStopLevel = stopLoss;
      }
    }

    if (dir === 'long') {
      if (!this.trailArmed && (lastPrice - entryPrice) >= act) {
        this.trailArmed = true;
        this.trailingStopLevel = Math.min(lastPrice, Math.max(stopLoss, lastPrice - off));
      }
      if (this.trailArmed) {
        const candidate = Math.min(lastPrice, Math.max(stopLoss, lastPrice - off));
        if (candidate > this.trailingStopLevel) this.trailingStopLevel = candidate;
        if (lastPrice <= this.trailingStopLevel) return 'hitTrail';
      }
      return 'none';
    } else {
      if (!this.trailArmed && (entryPrice - lastPrice) >= act) {
        this.trailArmed = true;
        this.trailingStopLevel = Math.max(lastPrice, Math.min(stopLoss, lastPrice + off));
      }
      if (this.trailArmed) {
        const candidate = Math.max(lastPrice, Math.min(stopLoss, lastPrice + off));
        if (candidate < this.trailingStopLevel) this.trailingStopLevel = candidate;
        if (lastPrice >= this.trailingStopLevel) return 'hitTrail';
      }
      return 'none';
    }
  }

  public getWarmUpStatus(): { isComplete: boolean; bars3min: number; bars15min: number } {
    return {
      isComplete: this.isWarmUpProcessed,
      bars3min: this.bars3min.length,
      bars15min: this.bars15min.length,
    };
  }
}
