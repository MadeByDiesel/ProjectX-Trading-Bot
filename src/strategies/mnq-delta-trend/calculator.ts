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

  constructor(config: StrategyConfig) {
    this.config = Object.freeze(JSON.parse(JSON.stringify(config)));
    this.technical = new TechnicalCalculator();
    console.info('[MNQDeltaTrend][Config:Calculator]', this.config);
  }

  public getConfig(): Readonly<StrategyConfig> {
    return this.config;
  }

  /** Warm-up loader */
  processWarmUpBar(bar: BarData, timeframe: '3min' | 'HTF'): void {
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

    // --- SESSION GATE ---
    try {
      const tz = 'America/New_York';
      const barTime = new Date(incoming.timestamp);
      const options: Intl.DateTimeFormatOptions = {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: tz,
      };
      const hhmm = new Intl.DateTimeFormat('en-US', options).format(barTime); // e.g. "09:24"

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

    const bar: BarData = {
      ...incoming,
      delta: typeof incoming.delta === 'number' && Number.isFinite(incoming.delta)
        ? Math.trunc(incoming.delta)
        : Number((incoming.close - incoming.open).toFixed(2)),
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
      // no gating: allow both sides
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

    // Directional parity: long only if above/at EMA, short only if below/at EMA
    return {
      passLong: lastClose >= lastEma,
      passShort: lastClose <= lastEma,
      lastClose,
      lastEma
    };
  }

  private determineTrend(): 'bullish' | 'bearish' | 'neutral' {
    if (this.bars15min.length < 2) return 'neutral';
    const L = Math.max(1, this.config.htfEMALength ?? 50);
    const useForming = this.config.htfUseForming !== false;
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
    if (this.bars3min.length < n + 1) {
      return { brokeUpCloseTol: false, brokeDownCloseTol: false };
    }
    const last = this.bars3min[this.bars3min.length - 1];
    const window = this.bars3min.slice(-n - 1, -1);
    const rangeHigh = Math.max(...window.map(b => b.high));
    const rangeLow = Math.min(...window.map(b => b.low));
    return {
      brokeUpCloseTol: last.close > rangeHigh * 0.995,
      brokeDownCloseTol: last.close < rangeLow * 0.995,
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

  private generateSignal(
    bar: BarData,
    marketState: MarketState,
    gates: { brokeUpCloseTol: boolean; brokeDownCloseTol: boolean; passLong: boolean; passShort: boolean }
  ): TradeSignal {
    const { brokeUpCloseTol, brokeDownCloseTol, passLong, passShort } = gates;

    // Read from StrategyConfig (UI fields). Fallbacks keep backward compatibility.
    const atrMultiplier =
      (this.config as any).atrMultiplier ??
      (this.config as any).atr_mult ??           // python-style key (if passed through)
      1.0;

    const atrThreshold =
      (this.config as any).atrThreshold ??
      (this.config as any).atr_threshold ??       // python-style key (if passed through)
      (this.config.minAtrToTrade ?? 0);

    // Gate: (ATR * multiplier) > threshold
    if (!(Number.isFinite(marketState.atr) && (marketState.atr * atrMultiplier) > atrThreshold)) {
      return {
        signal: 'hold',
        reason: `ATR gate failed (atr=${Number.isFinite(marketState.atr) ? marketState.atr.toFixed(2) : 'NaN'}, mult=${atrMultiplier}, thresh=${atrThreshold})`,
        confidence: 0
      };
    }

    const scale = (this.config as any).deltaScale ?? 1;
    const spike = (this.config.deltaSpikeThreshold ?? 750) * scale;
    const len = Math.max(1, this.config.deltaSMALength ?? 20);
    let avgAbsDelta = NaN;
    if (this.bars3min.length >= len) {
      const recent = this.bars3min.slice(-len);
      avgAbsDelta = recent.reduce((s, b) => s + Math.abs(b.delta ?? (b.close - b.open)), 0) / len;
    }
    const surge = Number.isFinite(avgAbsDelta) ? avgAbsDelta * (this.config.deltaSurgeMultiplier ?? 1.0) : 0;

    const delta = bar.delta ?? 0;
    const absDelta = Math.abs(delta);

    // ✅ FIXED: parity with Pine — fire if spike OR surge condition met
    const passDeltaLong  = (delta > 0) && (absDelta >= spike || absDelta >= surge);
    const passDeltaShort = (delta < 0) && (absDelta >= spike || absDelta >= surge);

    // 🔍 DEBUG: log delta gate evaluation for every bar
    console.debug('[MNQDeltaTrend][deltaCheck]', {
      delta,
      absDelta,
      spike,
      surge,
      passDeltaLong,
      passDeltaShort,
    });

    const htf = marketState.higherTimeframeTrend;
    console.debug('[MNQDeltaTrend][deltaCheck]', { delta, absDelta, spike, surge, passDeltaLong, passDeltaShort });

    // LONG decision (needs LTF above EMA when filter enabled)
    if (passDeltaLong && htf === 'bullish' && brokeUpCloseTol) {
      if (this.config.useEmaFilter && !passLong) {
        return { signal: 'hold', reason: 'LTF EMA long filter not passed', confidence: 0 };
      }
      return { signal: 'buy', reason: `Delta spike ${delta} > ${spike}, bullish HTF, close>rangeHigh*0.995`, confidence: 0.9 };
    }

    // SHORT decision (needs LTF below EMA when filter enabled)
    if (passDeltaShort && htf === 'bearish' && brokeDownCloseTol) {
      if (this.config.useEmaFilter && !passShort) {
        return { signal: 'hold', reason: 'LTF EMA short filter not passed', confidence: 0 };
      }
      return { signal: 'sell', reason: `Delta spike ${delta} < -${spike}, bearish HTF, close<rangeLow*1.005`, confidence: 0.9 };
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

  public setPosition(entryPrice: number, direction: 'long' | 'short', atrForTrail?: number): void {
    const atr = (typeof atrForTrail === 'number' && atrForTrail > 0) ? atrForTrail : (this.calculateATR() || 0);
    const slDist = atr * (this.config.atrStopLossMultiplier ?? 1.0);
    const stopLoss = direction === 'long' ? entryPrice - slDist : entryPrice + slDist;

    this.currentPosition = { entryPrice, entryTime: Date.now(), direction, stopLoss };

    // don’t seed trail here, just log activation distance
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