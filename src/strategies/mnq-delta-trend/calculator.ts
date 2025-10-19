// src/strategies/mnq-delta-trend/calculator.ts
import { BarData, MarketState, StrategyConfig, TradeSignal } from './types';
import { TechnicalCalculator } from '../../utils/technical';

console.log('[calc] loaded', __filename);

export class MNQDeltaTrendCalculator {
  private config: StrategyConfig;
  private technical: TechnicalCalculator;

  // Closed bars storage
  private bars3min: BarData[] = [];
  private bars15min: BarData[] = [];

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

  // Track HTF bucket to avoid duplicate/new-bar mistakes
  private lastHTFBucketStartMs: number | null = null;

  // Intra-bar signal tracking
  private lastIntraBarSignalTime = 0;
  private intraBarDeltaHistory: Array<{ delta: number; timestamp: number }> = [];
  private lastEntryBarTimestamp: string | null = null;

  constructor(config: StrategyConfig) {
    this.config = config;
    this.technical = new TechnicalCalculator();
    console.info('[MNQDeltaTrend][Config:Calculator]', this.config);
  }

  public getConfig(): Readonly<StrategyConfig> {
    return this.config;
  }

  processWarmUpBar(bar: BarData, timeframe: '3min' | 'HTF'): void {
    const arr = timeframe === '3min' ? this.bars3min : this.bars15min;

    const prevClose = arr.length ? arr[arr.length - 1].close : NaN;
    const vol = Number.isFinite(bar.volume as any) ? Number(bar.volume) : 0;
    const signedVol =
      Number.isFinite(prevClose) && Number.isFinite(bar.close)
        ? (bar.close > prevClose ? vol : bar.close < prevClose ? -vol : 0)
        : 0;

    const normalized: BarData = {
      ...bar,
      delta: (typeof bar.delta === 'number' && Number.isFinite(bar.delta))
        ? Math.trunc(bar.delta)
        : Math.trunc(signedVol),
    };

    arr.push(normalized);
    if (timeframe === '3min' && this.bars3min.length > 2000) this.bars3min.shift();
    if (timeframe === 'HTF' && this.bars15min.length > 1000) this.bars15min.shift();
  }

  completeWarmUp(): void {
    this.isWarmUpProcessed = true;
    if (this.bars3min.length > 0 || this.bars15min.length > 0) {
      void this.calculateATR();
      void this.determineTrend();
    }
  }

  processNewBar(incoming: BarData, marketState: MarketState): TradeSignal {
    if (!this.isWarmUpProcessed) {
      return { signal: 'hold', reason: 'Warm-up in progress', confidence: 0 };
    }

    // Session gate
    try {
      const tz = 'America/New_York';
      const barTime = new Date(incoming.timestamp);
      const options: Intl.DateTimeFormatOptions = {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: tz,
      };
      const hhmm = new Intl.DateTimeFormat('en-US', options).format(barTime);

      const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
      const currentMinutes = h * 60 + m;

      const [sh, sm] = (this.config.tradingStartTime ?? '09:30').split(':').map(n => parseInt(n, 10));
      const [eh, em] = (this.config.tradingEndTime ?? '15:55').split(':').map(n => parseInt(n, 10));
      const startMinutes = sh * 60 + sm;
      const endMinutes = eh * 60 + em;

      if (currentMinutes < startMinutes || currentMinutes > endMinutes) {
        return { signal: 'hold', reason: 'Out of session', confidence: 0 };
      }
    } catch (err) {
      console.warn('[MNQDeltaTrend][SessionGate] failed to parse time:', err);
    }

    const prevClose3m = this.bars3min.length ? this.bars3min[this.bars3min.length - 1].close : NaN;
    const vol = Number.isFinite(incoming.volume as any) ? Number(incoming.volume) : 0;
    const signedVol =
      Number.isFinite(prevClose3m) && Number.isFinite(incoming.close)
        ? (incoming.close > prevClose3m ? vol : incoming.close < prevClose3m ? -vol : 0)
        : 0;

    const bar: BarData = {
      ...incoming,
      delta: (typeof incoming.delta === 'number' && Number.isFinite(incoming.delta))
        ? Math.trunc(incoming.delta)
        : Math.trunc(signedVol),
    };

    this.bars3min.push(bar);
    if (this.bars3min.length > 2000) this.bars3min.shift();

    this.updateHigherTimeframeBars(bar);

    const atr = this.calculateATR();
    const trend = this.determineTrend();
    const { brokeUpCloseTol, brokeDownCloseTol } = this.checkBreakoutCloseTol();
    const { passLong, passShort } = this.checkLtfEmaFilter();

    marketState.atr = Number.isFinite(atr) ? atr : 0;
    marketState.higherTimeframeTrend = trend;
    marketState.deltaCumulative = (marketState.deltaCumulative ?? 0) + (bar.delta ?? 0);

    const exitSignal = this.checkExitConditions(bar, marketState);
    if (exitSignal) return exitSignal;

    return this.generateSignal(bar, marketState, { brokeUpCloseTol, brokeDownCloseTol, passLong, passShort });
  }

  private updateHigherTimeframeBars(bar: BarData): void {
    const htfMin = Math.max(1, Number((this.config as any).higherTimeframe ?? 15));
    const stepMs = htfMin * 60 * 1000;
    const tsMs = Date.parse(bar.timestamp);
    const bucketStartMs = Math.floor(tsMs / stepMs) * stepMs;
    const last = this.bars15min[this.bars15min.length - 1];

    if (!last || this.lastHTFBucketStartMs === null || bucketStartMs > this.lastHTFBucketStartMs) {
      this.bars15min.push({ ...bar });
      this.lastHTFBucketStartMs = bucketStartMs;
      if (this.bars15min.length > 1000) this.bars15min.shift();
      return;
    }

    last.high = Math.max(last.high, bar.high);
    last.low = Math.min(last.low, bar.low);
    last.close = bar.close;
    last.volume = (last.volume ?? 0) + (bar.volume ?? 0);
    if (typeof bar.delta === 'number') last.delta = (last.delta ?? 0) + bar.delta;
  }

  private calculateATR(): number {
    const period = 14;
    if (this.bars3min.length < period + 1) return NaN;

    const validTail: Array<{ open: number; high: number; low: number; close: number }> = [];
    for (let i = this.bars3min.length - 1; i >= 0 && validTail.length < period + 1; i--) {
      const b = this.bars3min[i];
      if ([b.open, b.high, b.low, b.close].every(v => Number.isFinite(v))) {
        validTail.push({ open: b.open, high: b.high, low: b.low, close: b.close });
      }
    }
    if (validTail.length < period + 1) return NaN;
    validTail.reverse();

    const tr: number[] = [];
    for (let i = 1; i < validTail.length; i++) {
      const h = validTail[i].high;
      const l = validTail[i].low;
      const prevC = validTail[i - 1].close;
      tr.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
    }
    if (tr.length < period) return NaN;

    let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < tr.length; i++) {
      atr = (atr * (period - 1) + tr[i]) / period;
    }
    return atr;
  }

  private checkLtfEmaFilter(): { passLong: boolean; passShort: boolean; lastClose: number; lastEma: number } {
    if (!this.config.useEmaFilter) {
      const lastClose = this.bars3min.length ? this.bars3min[this.bars3min.length - 1].close : NaN;
      return { passLong: true, passShort: true, lastClose, lastEma: NaN };
    }

    const L = Math.max(1, this.config.emaLength ?? 21);
    const closes = this.bars3min.map(b => b.close);
    if (closes.length < L) {
      return { passLong: false, passShort: false, lastClose: NaN, lastEma: NaN };
    }

    const emaSeries = this.technical.calculateEMA(closes, L);
    const lastClose = closes[closes.length - 1];
    const lastEma = emaSeries[emaSeries.length - 1];

    return {
      passLong: lastClose > lastEma,
      passShort: lastClose < lastEma,
      lastClose,
      lastEma
    };
  }

  private determineTrend(): 'bullish' | 'bearish' | 'neutral' {
    if (this.bars15min.length < 2) return 'neutral';
    const L = Math.max(1, this.config.htfEMALength ?? 50);
    const useForming = this.config.htfUseForming === true;
    const lastIdx = useForming ? this.bars15min.length - 1 : this.bars15min.length - 2;
    if (lastIdx < 0) return 'neutral';

    const closes = this.bars15min.slice(0, lastIdx + 1).map(b => b.close);
    if (closes.length < L) return 'neutral';

    const emaSeries = this.technical.calculateEMA(closes, L);
    const px = closes[closes.length - 1];
    const ema = emaSeries[emaSeries.length - 1];
    return px > ema ? 'bullish' : px < ema ? 'bearish' : 'neutral';
  }

  private checkBreakoutCloseTol() {
    const n = Math.max(1, this.config.breakoutLookbackBars ?? 20);
    if (this.bars3min.length < n) {
      return { brokeUpCloseTol: false, brokeDownCloseTol: false };
    }

    const window = this.bars3min.slice(-n);
    const last = window[window.length - 1];

    const rangeHigh = Math.max(...window.map(b => b.high));
    const rangeLow  = Math.min(...window.map(b => b.low));

    return {
      brokeUpCloseTol:   last.close > rangeHigh * 0.995,
      brokeDownCloseTol: last.close < rangeLow  * 1.005,
    };
  }

  private checkExitConditions(bar: BarData, _marketState: MarketState): TradeSignal | null {
    if (!this.currentPosition) return null;
    const { entryTime, direction, stopLoss } = this.currentPosition;
    const minBars = Math.max(0, this.config.minBarsBeforeExit ?? 0);
    const barsSinceEntry = this.bars3min.filter(b => new Date(b.timestamp).getTime() > entryTime).length;
    if (barsSinceEntry < minBars) return null;

    if (direction === 'long' && bar.low <= stopLoss) {
      return { signal: 'sell', reason: `Hit stop (${stopLoss.toFixed(2)})`, confidence: 1.0 };
    }
    if (direction === 'short' && bar.high >= stopLoss) {
      return { signal: 'buy', reason: `Hit stop (${stopLoss.toFixed(2)})`, confidence: 1.0 };
    }
    return null;
  }

  private checkDeltaSlopeExit(direction: 'long' | 'short'): TradeSignal | null {
    const n = Math.max(1, this.config.deltaSlopeExitLength ?? 5);
    if (this.bars3min.length < n + 1) return null;
    const smaNow = this.smaOfDelta(n, this.bars3min.length - 1);
    const smaPrev = this.smaOfDelta(n, this.bars3min.length - 2);
    if (!Number.isFinite(smaNow) || !Number.isFinite(smaPrev)) return null;
    const slope = smaNow - smaPrev;
    if (direction === 'long' && slope < 0) return { signal: 'sell', reason: 'Delta slope turning negative', confidence: 0.7 };
    if (direction === 'short' && slope > 0) return { signal: 'buy', reason: 'Delta slope turning positive', confidence: 0.7 };
    return null;
  }

  private smaOfDelta(n: number, endIndex: number): number {
    if (endIndex < 0) return NaN;
    const start = Math.max(0, endIndex - n + 1);
    if (endIndex - start + 1 < n) return NaN;
    let sum = 0;
    for (let i = start; i <= endIndex; i++) {
      sum += Math.abs(this.bars3min[i].delta ?? (this.bars3min[i].close - this.bars3min[i].open));
    }
    return sum / n;
  }

  private smaSignedDelta(n: number, endIndex: number): number {
    if (endIndex < 0) return NaN;
    const start = Math.max(0, endIndex - n + 1);
    if (endIndex - start + 1 < n) return NaN;
    let sum = 0;
    for (let i = start; i <= endIndex; i++) {
      const d = (this.bars3min[i].delta ?? (this.bars3min[i].close - (this.bars3min[i - 1]?.close ?? this.bars3min[i].open)));
      sum += Number(d) || 0;
    }
    return sum / n;
  }

  private generateSignal(
    bar: BarData,
    marketState: MarketState,
    gates: { brokeUpCloseTol: boolean; brokeDownCloseTol: boolean; passLong: boolean; passShort: boolean }
  ): TradeSignal {
    const { brokeUpCloseTol, brokeDownCloseTol, passLong, passShort } = gates;

    // Per-bar cooldown: prevent same-bar re-entry at bar close
    if (this.lastEntryBarTimestamp === bar.timestamp) {
      return { signal: 'hold', reason: 'Cooldown: same bar already triggered', confidence: 0 };
    }

    // ATR gate
    const atr = marketState.atr;
    const atrThreshold = this.config.minAtrToTrade ?? 0;
    
    if (!(Number.isFinite(atr) && atr > atrThreshold)) {
      return {
        signal: 'hold',
        reason: `ATR gate failed (${atr?.toFixed(2) ?? 'NaN'} <= ${atrThreshold})`,
        confidence: 0
      };
    }

    const spike = this.config.deltaSpikeThreshold ?? 750;
    const delta = bar.delta ?? 0;
    const absDelta = Math.abs(delta);

    const len = Math.max(1, this.config.deltaSMALength ?? 20);
    const deltaSMA = this.smaSignedDelta(len, this.bars3min.length - 1);
    
    if (!Number.isFinite(deltaSMA)) {
      return { signal: 'hold', reason: 'Delta SMA not ready', confidence: 0 };
    }

    const surgeMult = this.config.deltaSurgeMultiplier ?? 1.0;

    const passDeltaLong = (
      delta > spike && 
      delta > (deltaSMA * surgeMult)
    );

    const passDeltaShort = (
      delta < -spike && 
      delta < (deltaSMA * -surgeMult)  // FIXED: negative threshold
    );

    console.debug('[MNQDeltaTrend][deltaCheck]', {
      delta,
      absDelta,
      spike,
      deltaSMA,
      surgeMult,
      longThreshold: deltaSMA * surgeMult,
      shortThreshold: deltaSMA * -surgeMult,
      passDeltaLong,
      passDeltaShort,
    });

    const htf = marketState.higherTimeframeTrend;

    // Long entry
    if (passDeltaLong && htf === 'bullish' && brokeUpCloseTol) {
      if (this.config.useEmaFilter && !passLong) {
        return { signal: 'hold', reason: 'LTF EMA long filter not passed', confidence: 0 };
      }
      
      this.lastEntryBarTimestamp = bar.timestamp;
      
      return { 
        signal: 'buy', 
        reason: `Δ=${delta.toFixed(0)} > spike=${spike} & > SMA×mult=${(deltaSMA * surgeMult).toFixed(0)}, bullish HTF, breakout`, 
        confidence: 0.9 
      };
    }

    // Short entry
    if (passDeltaShort && htf === 'bearish' && brokeDownCloseTol) {
      if (this.config.useEmaFilter && !passShort) {
        return { signal: 'hold', reason: 'LTF EMA short filter not passed', confidence: 0 };
      }
      
      this.lastEntryBarTimestamp = bar.timestamp;
      
      return { 
        signal: 'sell', 
        reason: `Δ=${delta.toFixed(0)} < -spike=${-spike} & < SMA×(-mult)=${(deltaSMA * -surgeMult).toFixed(0)}, bearish HTF, breakdown`, 
        confidence: 0.9 
      };
    }

    return { signal: 'hold', reason: 'No strong signal', confidence: 0 };
  }

  calculatePositionSize(currentPrice: number, atr: number, accountBalance: number): number {
    void currentPrice;
    const riskAmount = accountBalance * 0.01;
    const riskPerContract = atr * (this.config.atrStopLossMultiplier ?? 1);
    if (!Number.isFinite(riskPerContract) || riskPerContract <= 0) return 1;
    const size = Math.floor(riskAmount / riskPerContract);
    return Math.min(Math.max(1, size), this.config.contractQuantity ?? 1);
  }

  public setPosition(entryPrice: number, direction: 'long' | 'short', atrForTrail?: number): void {
    const atr = (typeof atrForTrail === 'number' && atrForTrail > 0) ? atrForTrail : (this.calculateATR() || 0);
    const slDist = atr * (this.config.atrStopLossMultiplier ?? 1.0);
    const stopLoss = direction === 'long' ? entryPrice - slDist : entryPrice + slDist;

    this.currentPosition = { entryPrice, entryTime: Date.now(), direction, stopLoss };

    this.trailingStopLevel = stopLoss;
    this.trailArmed = false;
    this.noTrailBeforeMs = Date.now() + (((this as any).config?.tickExitGraceMs ?? 2000) | 0);

    console.info('[MNQDeltaTrend][ENTRY:init]', {
      dir: direction,
      entry: entryPrice,
      atr,
      stopLoss,
      trailActivationMove: atr * (this.config.trailActivationATR ?? 1.5)
    });
  }

  /**
   * Evaluate a forming (incomplete) bar for intra-bar signal generation.
   */
  public evaluateFormingBar(
    formingBar: BarData,
    marketState: MarketState,
    accumulationTimeMs: number
  ): TradeSignal {
    if (!this.isWarmUpProcessed) {
      return { signal: 'hold', reason: 'Warm-up incomplete', confidence: 0 };
    }

    if (this.hasPosition()) {
      return { signal: 'hold', reason: 'Already in position', confidence: 0 };
    }

    // Session gate
    try {
      const tz = 'America/New_York';
      const barTime = new Date(formingBar.timestamp);
      const options: Intl.DateTimeFormatOptions = {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: tz,
      };
      const hhmm = new Intl.DateTimeFormat('en-US', options).format(barTime);
      const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
      const currentMinutes = h * 60 + m;
      const [sh, sm] = (this.config.tradingStartTime ?? '09:30').split(':').map(n => parseInt(n, 10));
      const [eh, em] = (this.config.tradingEndTime ?? '15:55').split(':').map(n => parseInt(n, 10));
      const startMinutes = sh * 60 + sm;
      const endMinutes = eh * 60 + em;

      if (currentMinutes < startMinutes || currentMinutes > endMinutes) {
        return { signal: 'hold', reason: 'Out of session', confidence: 0 };
      }
    } catch (err) {
      console.warn('[MNQDeltaTrend][FormingBar] session check failed:', err);
    }

    // Safeguard 1: Minimum accumulation time
    const minAccumMs = this.config.intraBarMinAccumulationMs ?? 5000;
    if (accumulationTimeMs < minAccumMs) {
      return { 
        signal: 'hold', 
        reason: `Accumulation time ${accumulationTimeMs}ms < min ${minAccumMs}ms`, 
        confidence: 0 
      };
    }

    // Safeguard 2: Confirmation window
    const nowMs = Date.now();
    const delta = formingBar.delta ?? 0;
    
    this.intraBarDeltaHistory.push({ delta, timestamp: nowMs });
    
    const confirmWindowMs = this.config.intraBarConfirmationWindowMs ?? 500;
    this.intraBarDeltaHistory = this.intraBarDeltaHistory.filter(
      entry => (nowMs - entry.timestamp) <= confirmWindowMs
    );
    
    const requiredConfirmations = this.config.intraBarConfirmationChecks ?? 3;
    if (this.intraBarDeltaHistory.length < requiredConfirmations) {
      return { 
        signal: 'hold', 
        reason: `Need ${requiredConfirmations} confirmations, have ${this.intraBarDeltaHistory.length}`, 
        confidence: 0 
      };
    }

    // Safeguard 3: Signal cooldown
    const cooldownMs = 2000;
    if ((nowMs - this.lastIntraBarSignalTime) < cooldownMs) {
      return { 
        signal: 'hold', 
        reason: 'Signal cooldown active', 
        confidence: 0 
      };
    }

    // Use closed bars for all indicators
    const atr = this.calculateATR();
    const trend = this.determineTrend();
    const { brokeUpCloseTol, brokeDownCloseTol } = this.checkBreakoutCloseTol();
    const { passLong, passShort } = this.checkLtfEmaFilter();

    marketState.atr = Number.isFinite(atr) ? atr : 0;
    marketState.higherTimeframeTrend = trend;

    const signal = this.generateSignalForFormingBar(
      formingBar, 
      marketState, 
      { brokeUpCloseTol, brokeDownCloseTol, passLong, passShort }
    );

    if (signal.signal === 'buy' || signal.signal === 'sell') {
      this.lastIntraBarSignalTime = nowMs;
    }

    return signal;
  }

  /**
   * Generate signal based on forming bar delta and closed bar indicators.
   */
  private generateSignalForFormingBar(
    formingBar: BarData,
    marketState: MarketState,
    gates: { brokeUpCloseTol: boolean; brokeDownCloseTol: boolean; passLong: boolean; passShort: boolean }
  ): TradeSignal {
    const { brokeUpCloseTol, brokeDownCloseTol, passLong, passShort } = gates;

    // ATR gate
    const atr = marketState.atr;
    const atrThreshold = this.config.minAtrToTrade ?? 0;
    
    if (!(Number.isFinite(atr) && atr > atrThreshold)) {
      return {
        signal: 'hold',
        reason: `ATR gate failed (forming bar)`,
        confidence: 0
      };
    }

    const spike = this.config.deltaSpikeThreshold ?? 750;
    const delta = formingBar.delta ?? 0;
    const absDelta = Math.abs(delta);

    // Use last CLOSED bar's SMA
    const len = Math.max(1, this.config.deltaSMALength ?? 20);
    const deltaSMA = this.smaSignedDelta(len, this.bars3min.length - 1);
    
    if (!Number.isFinite(deltaSMA)) {
      return { signal: 'hold', reason: 'Delta SMA not ready', confidence: 0 };
    }

    const surgeMult = this.config.deltaSurgeMultiplier ?? 1.0;

    // Safeguard 4: All confirmations must pass
    const longThreshold = deltaSMA * surgeMult;
    const shortThreshold = deltaSMA * -surgeMult;
    
    const allConfirmLong = this.intraBarDeltaHistory.every(
      entry => entry.delta > spike && entry.delta > longThreshold
    );
    
    const allConfirmShort = this.intraBarDeltaHistory.every(
      entry => entry.delta < -spike && entry.delta < shortThreshold
    );

    const passDeltaLong = (delta > spike && delta > longThreshold && allConfirmLong);
    const passDeltaShort = (delta < -spike && delta < shortThreshold && allConfirmShort);
    
    console.debug('[MNQDeltaTrend][formingBarCheck]', {
      delta,
      absDelta,
      spike,
      deltaSMA,
      surgeMult,
      longThreshold,
      shortThreshold,
      confirmations: this.intraBarDeltaHistory.length,
      allConfirmLong,
      allConfirmShort,
      passDeltaLong,
      passDeltaShort,
      formingPrice: formingBar.close,
    });

    const htf = marketState.higherTimeframeTrend;

    // Long entry
    if (passDeltaLong && htf === 'bullish' && brokeUpCloseTol) {
      if (this.config.useEmaFilter && !passLong) {
        return { signal: 'hold', reason: 'LTF EMA long filter (forming)', confidence: 0 };
      }
      return { 
        signal: 'buy', 
        reason: `[INTRA-BAR] Δ=${delta.toFixed(0)} > ${spike} & > ${longThreshold.toFixed(0)} (${this.intraBarDeltaHistory.length} confirms), bullish HTF, breakout`, 
        confidence: 0.85
      };
    }

    // Short entry
    if (passDeltaShort && htf === 'bearish' && brokeDownCloseTol) {
      if (this.config.useEmaFilter && !passShort) {
        return { signal: 'hold', reason: 'LTF EMA short filter (forming)', confidence: 0 };
      }
      return { 
        signal: 'sell', 
        reason: `[INTRA-BAR] Δ=${delta.toFixed(0)} < ${-spike} & < ${shortThreshold.toFixed(0)} (${this.intraBarDeltaHistory.length} confirms), bearish HTF, breakdown`, 
        confidence: 0.85
      };
    }

    return { signal: 'hold', reason: 'No intra-bar signal', confidence: 0 };
  }

  /**
   * Reset intra-bar tracking when a new bar starts.
   */
  public resetIntraBarTracking(): void {
    this.intraBarDeltaHistory = [];
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

  public onTickForProtectiveStops(lastPrice: number, atrNow: number): 'none' | 'hitStop' | 'hitTrail' {
    if (!this.currentPosition || !Number.isFinite(lastPrice)) return 'none';
    const { direction: dir, entryPrice, stopLoss } = this.currentPosition;

    if (dir === 'long' && lastPrice <= stopLoss) return 'hitStop';
    if (dir === 'short' && lastPrice >= stopLoss) return 'hitStop';
    if (Date.now() < this.noTrailBeforeMs) return 'none';

    const atr = Number.isFinite(atrNow) && atrNow > 0 ? atrNow : this.calculateATR();
    if (!Number.isFinite(atr) || atr <= 0) return 'none';

    const act = atr * (this.config.trailActivationATR ?? 1.5);
    const off = atr * (this.config.trailOffsetATR ?? 1.0);

    if (dir === 'long') {
      if (!this.trailArmed && (lastPrice - entryPrice) >= act) {
        this.trailArmed = true;
        this.trailingStopLevel = Math.max(stopLoss, lastPrice - off);
      }
      if (this.trailArmed) {
        const candidate = Math.max(stopLoss, lastPrice - off);
        if (candidate > this.trailingStopLevel) this.trailingStopLevel = candidate;
        if (lastPrice <= this.trailingStopLevel) return 'hitTrail';
      }
    } else {
      if (!this.trailArmed && (entryPrice - lastPrice) >= act) {
        this.trailArmed = true;
        this.trailingStopLevel = Math.min(stopLoss, lastPrice + off);
      }
      if (this.trailArmed) {
        const candidate = Math.min(stopLoss, lastPrice + off);
        if (candidate < this.trailingStopLevel) this.trailingStopLevel = candidate;
        if (lastPrice >= this.trailingStopLevel) return 'hitTrail';
      }
    }
    return 'none';
  }

  public getWarmUpStatus() {
    return { isComplete: this.isWarmUpProcessed, bars3min: this.bars3min.length, bars15min: this.bars15min.length };
  }
}