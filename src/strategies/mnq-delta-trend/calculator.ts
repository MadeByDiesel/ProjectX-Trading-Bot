import { BarData, MarketState, StrategyConfig, TradeSignal } from './types';
import { TechnicalCalculator } from '../../utils/technical';

// === Tick helpers (MNQ = 0.25) ===
const TICK_SIZE = 0.25;
const snapToTick = (p: number): number => Math.round(p / TICK_SIZE) * TICK_SIZE;
const snapStop = (p: number, dir: 'long' | 'short'): number =>
  dir === 'long' ? Math.floor(p / TICK_SIZE) * TICK_SIZE : Math.ceil(p / TICK_SIZE) * TICK_SIZE;

export class MNQDeltaTrendCalculator {
  private config: StrategyConfig;
  private technical: TechnicalCalculator;

  // Closed bars
  private bars3min: BarData[] = [];
  private bars15min: BarData[] = [];
  private isWarmUpProcessed = false;

  // Position / trail
  private currentPosition: { entryPrice: number; entryTime: number; direction: 'long' | 'short'; stopLoss: number } | null = null;
  private trailingStopLevel = 0;
  private fixedTrail: { offPts: number; actPts: number; entryATR: number } | null = null;

  // HTF bucket tracker
  private lastHTFBucketStartMs: number | null = null;

  // Intrabar state
  private intraBarDeltaHistory: Array<{ delta: number; timestamp: number }> = [];
  private firstDeltaMsInBar = 0;
  private lastIntraBarSignalTime = 0;

  // Bar-close gating
  private lastEntryBarTimestamp: string | null = null;

  // Stash ATR at signal time for parity fallback
  private lastAtrAtSignal: number | null = null;

  private regimeState = {
    current: 'Normal' as 'Chop' | 'Normal' | 'Trend',
    atrSamples: [] as number[],
    cvdSlopeSamples: [] as number[],
  };

  private baseConfig!: Readonly<StrategyConfig>;

  constructor(config: StrategyConfig) {
    this.config = config;
    this.technical = new TechnicalCalculator();
     this.baseConfig = JSON.parse(JSON.stringify(config));
  }

  public getConfig(): Readonly<StrategyConfig> { return this.config; }
  public hasPosition(): boolean { return !!this.currentPosition; }
  public getPositionDirection(): 'long' | 'short' | null { return this.currentPosition?.direction ?? null; }

  // ===== Warmup / session =====
  public processWarmUpBar(bar: BarData, timeframe: '3min' | 'HTF'): void {
    const arr = timeframe === '3min' ? this.bars3min : this.bars15min;

    const prevClose = arr.length ? arr[arr.length - 1].close : NaN;
    const vol = Number.isFinite(bar.volume as any) ? Number(bar.volume) : 0;
    const signedVol =
      Number.isFinite(prevClose) && Number.isFinite(bar.close)
        ? (bar.close > prevClose ? vol : bar.close < prevClose ? -vol : 0)
        : 0;

    const normalized: BarData = {
      ...bar,
      delta: Number.isFinite(bar.delta as any) ? Math.trunc(Number(bar.delta)) : Math.trunc(signedVol),
    };

    arr.push(normalized);
    if (timeframe === '3min' && this.bars3min.length > 2000) this.bars3min.shift();
    if (timeframe === 'HTF' && this.bars15min.length > 1000) this.bars15min.shift();
  }

  public completeWarmUp(): void { this.isWarmUpProcessed = true; }

  private inSession(tsISO: string): boolean {
    try {
      const tz = 'America/New_York';
      const t = new Date(tsISO);
      const fmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
      const [h, m] = fmt.format(t).split(':').map(n => parseInt(n, 10));
      const now = h * 60 + m;
      const [sh, sm] = (this.config.tradingStartTime ?? '09:30').split(':').map(n => parseInt(n, 10));
      const [eh, em] = (this.config.tradingEndTime ?? '15:55').split(':').map(n => parseInt(n, 10));
      return now >= sh * 60 + sm && now <= eh * 60 + em;
    } catch {
      return true;
    }
  }

  // ===== ATR (RMA) =====
  private calculateATR(): number {
    const n = 14;
    if (this.bars3min.length < n + 1) return NaN;

    const tr: number[] = [];
    for (let i = 1; i < this.bars3min.length; i++) {
      const c = this.bars3min[i], p = this.bars3min[i - 1];
      tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    if (tr.length < n) return NaN;

    let atr = tr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    for (let i = n; i < tr.length; i++) atr = (atr * (n - 1) + tr[i]) / n;
    return atr;
  }

  public atrWithForming(formingBar: BarData): number {
    this.bars3min.push(formingBar);
    const a = this.calculateATR();
    this.bars3min.pop();
    return a;
  }

  // ===== Trend / HTF bucketing =====
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

  private determineTrend(): 'bullish' | 'bearish' | 'neutral' {
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

  // ===== Breakout gates =====
  private checkBreakoutIntrabar(formingBar: BarData) {
    const n = Math.max(1, this.config.breakoutLookbackBars ?? 20);
    if (this.bars3min.length < n) return { brokeUp: false, brokeDown: false };
    const window = this.bars3min.slice(-n);
    const rangeHigh = Math.max(...window.map(b => b.high));
    const rangeLow = Math.min(...window.map(b => b.low));
    return { brokeUp: formingBar.high > rangeHigh, brokeDown: formingBar.low < rangeLow };
  }

  private checkBreakoutCloseTol() {
    const n = Math.max(1, this.config.breakoutLookbackBars ?? 20);
    if (this.bars3min.length < n) return { brokeUpCloseTol: false, brokeDownCloseTol: false };

    const window = this.bars3min.slice(-n);
    const last = window[window.length - 1];
    const rangeHigh = Math.max(...window.map(b => b.high));
    const rangeLow = Math.min(...window.map(b => b.low));

    return { brokeUpCloseTol: last.close > rangeHigh * 0.995, brokeDownCloseTol: last.close < rangeLow * 1.005 };
  }

  // ===== EMA filter (LTF) =====
  private checkLtfEmaFilter(): { passLong: boolean; passShort: boolean } {
    if (!this.config.useEmaFilter) return { passLong: true, passShort: true };
    const L = Math.max(1, this.config.emaLength ?? 21);
    const closes = this.bars3min.map(b => b.close);
    if (closes.length < L) return { passLong: false, passShort: false };
    const ema = this.technical.calculateEMA(closes, L);
    const lastClose = closes[closes.length - 1];
    const lastEma = ema[ema.length - 1];
    return { passLong: lastClose > lastEma, passShort: lastClose < lastEma };
  }

  private checkLtfEmaFilterWithForming(formingClose: number): { passLong: boolean; passShort: boolean } {
    if (!this.config.useEmaFilter) return { passLong: true, passShort: true };
    const L = Math.max(1, this.config.emaLength ?? 21);
    const closes = this.bars3min.map(b => b.close);
    if (closes.length === 0) return { passLong: false, passShort: false };
    const seed = this.technical.calculateEMA(closes, Math.min(L, closes.length));
    const lastEmaClosed = seed[seed.length - 1];
    if (!Number.isFinite(lastEmaClosed)) return { passLong: false, passShort: false };
    const alpha = 2 / (L + 1);
    const emaWithForming = alpha * formingClose + (1 - alpha) * lastEmaClosed;
    return { passLong: formingClose > emaWithForming, passShort: formingClose < emaWithForming };
  }

  // ===== Delta math =====
  private smaSignedDelta(n: number, endIndex?: number): number {
    const end = typeof endIndex === 'number' ? endIndex : this.bars3min.length - 1;
    if (end < 0) return NaN;
    const start = Math.max(0, end - n + 1);
    if (end - start + 1 < n) return NaN;
    let sum = 0;
    for (let i = start; i <= end; i++) sum += Number(this.bars3min[i].delta ?? 0);
    return sum / n;
  }

   private updateRegime(atrValue: number, cvdSlope: number): void {
    const s = this.regimeState;

    if (Number.isFinite(atrValue)) s.atrSamples.push(atrValue);
    s.cvdSlopeSamples.push(Math.abs(cvdSlope));
    if (s.atrSamples.length > 20) s.atrSamples.shift();
    if (s.cvdSlopeSamples.length > 20) s.cvdSlopeSamples.shift();

    const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
    const atrMean = s.atrSamples.length ? mean(s.atrSamples) : Number(atrValue || 0);
    const cvdMean = s.cvdSlopeSamples.length ? mean(s.cvdSlopeSamples) : Math.abs(cvdSlope);
    const cvdStd = Math.sqrt(
      s.cvdSlopeSamples.map(v => (v - cvdMean) ** 2).reduce((a, b) => a + b, 0) / Math.max(1, s.cvdSlopeSamples.length)
    );

    let next: 'Chop' | 'Normal' | 'Trend' = 'Normal';
    if (Number.isFinite(atrValue) && atrValue < atrMean * 0.8 && cvdStd < cvdMean * 0.8) next = 'Chop';
    else if ((Number.isFinite(atrValue) && atrValue > atrMean * 1.2) || cvdStd > cvdMean * 1.2) next = 'Trend';

    if (next !== s.current) {
      if (Number.isFinite(atrValue)) {
        console.info(`[Regime] ${s.current}→${next} | ATR=${Number(atrValue).toFixed(2)} | dCVDσ=${cvdStd.toFixed(0)}`);
      }
      s.current = next;
    }
  }

  private applyRegimeScaling(): void {
    // reset to baseline first
    Object.assign(this.config, this.baseConfig);

    const r = this.regimeState.current;
    const c = this.config as any;
    const scale = (v: number, m: number) => Number((v * m).toFixed(4));

    if (r === 'Chop') {
      c.deltaSpikeThreshold = scale(c.deltaSpikeThreshold, 1.30);
      c.minAtrToTrade      = scale(c.minAtrToTrade,      1.20);
      c.trailActivationATR = scale(c.trailActivationATR, 1.30);
      c.trailOffsetATR     = scale(c.trailOffsetATR,     1.30);
      if (c.cvdSlopeMinAbs !== undefined) c.cvdSlopeMinAbs = scale(c.cvdSlopeMinAbs, 1.50);
      if (c.clusterMinVolume !== undefined) c.clusterMinVolume = Math.round(c.clusterMinVolume * 1.30);
    } else if (r === 'Trend') {
      c.deltaSpikeThreshold = scale(c.deltaSpikeThreshold, 0.85);
      c.minAtrToTrade      = scale(c.minAtrToTrade,      0.80);
      c.trailActivationATR = scale(c.trailActivationATR, 0.75);
      c.trailOffsetATR     = scale(c.trailOffsetATR,     0.75);
      if (c.cvdSlopeMinAbs !== undefined) c.cvdSlopeMinAbs = scale(c.cvdSlopeMinAbs, 0.80);
      if (c.clusterMinVolume !== undefined) c.clusterMinVolume = Math.max(1, Math.round(c.clusterMinVolume * 0.85));
    }
  }

  // ===== Bar-close signal =====
  public processNewBar(incoming: BarData, marketState: MarketState): TradeSignal {
    if (!this.isWarmUpProcessed || !this.inSession(incoming.timestamp)) return { signal: 'hold', reason: 'session/warmup', confidence: 0 };

    // Normalize delta for the bar
    const prevClose = this.bars3min.length ? this.bars3min[this.bars3min.length - 1].close : NaN;
    const vol = Number.isFinite(incoming.volume as any) ? Number(incoming.volume) : 0;
    const signedVol =
      Number.isFinite(prevClose) && Number.isFinite(incoming.close)
        ? (incoming.close > prevClose ? vol : incoming.close < prevClose ? -vol : 0)
        : 0;

    const bar: BarData = {
      ...incoming,
      delta: Number.isFinite(incoming.delta as any) ? Math.trunc(Number(incoming.delta)) : Math.trunc(signedVol),
    };

    this.bars3min.push(bar);
    if (this.bars3min.length > 2000) this.bars3min.shift();

    this.updateHigherTimeframeBars(bar);

    const atr = this.calculateATR();
    const trend = this.determineTrend();
    marketState.atr = Number.isFinite(atr) ? atr : 0;
    marketState.higherTimeframeTrend = trend;

    // Regime update only when ATR is valid
    if (Number.isFinite(atr)) {
      const currDelta = Number(bar.delta ?? 0);
      const prevDelta = this.bars3min.length >= 2 ? Number(this.bars3min[this.bars3min.length - 2].delta ?? 0) : 0;
      const cvdSlope = Math.abs(currDelta - prevDelta);

      this.updateRegime(atr, cvdSlope);
      this.applyRegimeScaling(); // <-- now scales using current regime
    }

    // Exit checks first (bar-close)
    const exit = this.checkExitConditions(bar);
    if (exit) return exit;

    // ATR gate
    const atrThr = this.config.minAtrToTrade ?? 0;
    if (!(Number.isFinite(atr) && atr > atrThr)) return { signal: 'hold', reason: 'ATR gate', confidence: 0 };
    const { brokeUpCloseTol, brokeDownCloseTol } = this.checkBreakoutCloseTol();
    const { passLong, passShort } = this.checkLtfEmaFilter();

    const spike = this.config.deltaSpikeThreshold ?? 750;
    const len = Math.max(1, this.config.deltaSMALength ?? 20);
    const deltaSMA = this.smaSignedDelta(len, this.bars3min.length - 1);
    if (!Number.isFinite(deltaSMA)) return { signal: 'hold', reason: 'Delta SMA not ready', confidence: 0 };

    const mult = this.config.deltaSurgeMultiplier ?? 1.2;
    const d = bar.delta ?? 0;
    const passDeltaLong = d > spike && d > deltaSMA * mult;
    const passDeltaShort = d < -spike && d < deltaSMA * -mult;

    if (passDeltaLong && passLong && brokeUpCloseTol && trend === 'bullish') {
      this.lastEntryBarTimestamp = bar.timestamp;
      this.lastAtrAtSignal = atr;
      return { signal: 'buy', reason: `Δ=${d} > SMA×mult=${(deltaSMA * mult).toFixed(0)}`, confidence: 0.9 };
    }
    if (passDeltaShort && passShort && brokeDownCloseTol && trend === 'bearish') {
      this.lastEntryBarTimestamp = bar.timestamp;
      this.lastAtrAtSignal = atr;
      return { signal: 'sell', reason: `Δ=${d} < SMA×mult=${(deltaSMA * -mult).toFixed(0)}`, confidence: 0.9 };
    }

    return { signal: 'hold', reason: 'no signal', confidence: 0 };
  }

  // ===== Forming-bar signal =====
  public evaluateFormingBar(formingBar: BarData, marketState: MarketState): TradeSignal {
    if (!this.isWarmUpProcessed) return { signal: 'hold', reason: 'warmup', confidence: 0 };
    if (!this.inSession(formingBar.timestamp)) return { signal: 'hold', reason: 'out of session', confidence: 0 };
    if (this.hasPosition()) return { signal: 'hold', reason: 'already in position', confidence: 0 };
        // Apply regime-based scaling for this forming bar
    this.applyRegimeScaling();

    const nowMs = Date.now();
    const delta = formingBar.delta ?? 0;

    this.intraBarDeltaHistory.push({ delta, timestamp: nowMs });
    if (this.firstDeltaMsInBar === 0) this.firstDeltaMsInBar = nowMs;

    const confirmWindowMs = this.config.intraBarConfirmationWindowMs ?? 500;
    this.intraBarDeltaHistory = this.intraBarDeltaHistory.filter(e => (nowMs - e.timestamp) <= confirmWindowMs);

    const minAccumMs = this.config.intraBarMinAccumulationMs ?? 5000;
    if ((nowMs - this.firstDeltaMsInBar) < minAccumMs) return { signal: 'hold', reason: 'accumulating', confidence: 0 };

    const requiredConfirmations = this.config.intraBarConfirmationChecks ?? 3;
    if (this.intraBarDeltaHistory.length < requiredConfirmations) return { signal: 'hold', reason: 'need confirmations', confidence: 0 };

    // Cooldown
    const cooldownMs = 2000;
    if ((nowMs - this.lastIntraBarSignalTime) < cooldownMs) return { signal: 'hold', reason: 'intrabar cooldown', confidence: 0 };

    // ATR gate — Pine-like including forming snapshot
    const atr = this.atrWithForming(formingBar);
    marketState.atr = Number.isFinite(atr) ? atr : 0;
    marketState.higherTimeframeTrend = this.determineTrend();

    const atrThr = this.config.minAtrToTrade ?? 0;
    if (!(Number.isFinite(atr) && atr > atrThr)) return { signal: 'hold', reason: 'ATR gate forming', confidence: 0 };
    
    const { brokeUp, brokeDown } = this.checkBreakoutIntrabar(formingBar);
    const { passLong, passShort } = this.checkLtfEmaFilterWithForming(formingBar.close);

    const len = Math.max(1, this.config.deltaSMALength ?? 20);
    const deltaSMA = this.smaSignedDelta(len, this.bars3min.length - 1);
    if (!Number.isFinite(deltaSMA)) return { signal: 'hold', reason: 'Delta SMA not ready', confidence: 0 };

    const spike = this.config.deltaSpikeThreshold ?? 750;
    const mult = this.config.deltaSurgeMultiplier ?? 1.2;
    const longThr = deltaSMA * mult;
    const shortThr = deltaSMA * -mult;

    const allConfirmLong = this.intraBarDeltaHistory.every(e => e.delta > spike && e.delta > longThr);
    const allConfirmShort = this.intraBarDeltaHistory.every(e => e.delta < -spike && e.delta < shortThr);

    const passDeltaLong = delta > spike && delta > longThr && allConfirmLong;
    const passDeltaShort = delta < -spike && delta < shortThr && allConfirmShort;

    const trend = marketState.higherTimeframeTrend;

    if (passDeltaLong && passLong && brokeUp && trend === 'bullish') {
      this.lastIntraBarSignalTime = nowMs;
      this.lastEntryBarTimestamp = formingBar.timestamp;
      this.lastAtrAtSignal = atr;
      return { signal: 'buy', reason: `[INTRA] Δ=${delta} > ${longThr.toFixed(0)} (${this.intraBarDeltaHistory.length} conf)`, confidence: 0.85 };
    }

    if (passDeltaShort && passShort && brokeDown && trend === 'bearish') {
      this.lastIntraBarSignalTime = nowMs;
      this.lastEntryBarTimestamp = formingBar.timestamp;
      this.lastAtrAtSignal = atr;
      return { signal: 'sell', reason: `[INTRA] Δ=${delta} < ${shortThr.toFixed(0)} (${this.intraBarDeltaHistory.length} conf)`, confidence: 0.85 };
    }

    return { signal: 'hold', reason: 'no intrabar signal', confidence: 0 };
  }

  // ===== Exit checks (bar-close) =====
  private checkExitConditions(bar: BarData): TradeSignal | null {
    if (!this.currentPosition) return null;

    const { entryTime, direction } = this.currentPosition;
    const minBars = Math.max(0, this.config.minBarsBeforeExit ?? 0);
    const barsSinceEntry = this.bars3min.filter(b => new Date(b.timestamp).getTime() > entryTime).length;
    if (barsSinceEntry < minBars) return null;

    const stop = this.currentPosition.stopLoss;
    const trail = this.trailingStopLevel;

    if (direction === 'long') {
      if (bar.low <= stop) return { signal: 'sell', reason: `Hit stop (${stop.toFixed(2)})`, confidence: 1.0 };
      if (bar.low <= trail) return { signal: 'sell', reason: `Hit trail (${trail.toFixed(2)})`, confidence: 1.0 };
    } else {
      if (bar.high >= stop) return { signal: 'buy', reason: `Hit stop (${stop.toFixed(2)})`, confidence: 1.0 };
      if (bar.high >= trail) return { signal: 'buy', reason: `Hit trail (${trail.toFixed(2)})`, confidence: 1.0 };
    }
    return null;
  }

  // ===== Intra-bar management =====
  public resetIntraBarTracking(): void {
    this.intraBarDeltaHistory = [];
    this.firstDeltaMsInBar = 0;
  }

  public clearCooldowns(): void {
    this.lastIntraBarSignalTime = 0;
    this.lastEntryBarTimestamp = null;
  }

  // ===== Position / Trail =====
  public setPosition(entryPrice: number, direction: 'long' | 'short', _atrForTrail?: number): void {
    // Seed ATR: prefer caller; else stashed at signal; else compute
    const caller = Number.isFinite(_atrForTrail as number) ? Number(_atrForTrail) : NaN;
    const stash = Number.isFinite(this.lastAtrAtSignal as number) ? Number(this.lastAtrAtSignal) : NaN;
    const computed = this.calculateATR();

    const atrAtEntry = Number.isFinite(caller) ? caller : Number.isFinite(stash) ? stash : computed;
    if (!Number.isFinite(atrAtEntry) || atrAtEntry <= 0) return;

    // ATR cap at entry (configurable)
    const ATR_CAP = (this.config as any).atrCap ?? 24;
    const baseSlMult = Number(this.config.atrStopLossMultiplier ?? 0.20);
    const offMult = Number(this.config.trailOffsetATR ?? 0.125);
    const actMult = Math.max(0, Number(this.config.trailActivationATR ?? 0.30));

    const seed = Math.min(atrAtEntry, ATR_CAP);
    const slPts = seed * baseSlMult;
    const offPts = seed * offMult;
    const actPts = seed * actMult;

    this.fixedTrail = { offPts, actPts, entryATR: seed };

    const stop = direction === 'long' ? snapStop(entryPrice - slPts, 'long') : snapStop(entryPrice + slPts, 'short');

    this.currentPosition = { entryPrice, entryTime: Date.now(), direction, stopLoss: stop };
    this.trailingStopLevel = stop;
  }

  public clearPosition(): void {
    this.currentPosition = null;
    this.trailingStopLevel = 0;
    this.fixedTrail = null;
    this.lastAtrAtSignal = null;
    this.lastEntryBarTimestamp = null;
    this.lastIntraBarSignalTime = 0;
  }

  public onTickForProtectiveStops(lastPrice: number, _atrNow: number): 'none' | 'hitStop' | 'hitTrail' {
    if (!this.currentPosition || !Number.isFinite(lastPrice)) return 'none';
    if (!this.fixedTrail) return 'none';

    // Honor minBarsBeforeExit before trailing engages
    const minBars = Math.max(0, this.config.minBarsBeforeExit ?? 0);
    if (minBars > 0) {
      const { entryTime } = this.currentPosition;
      const barsSinceEntry = this.bars3min.filter(b => new Date(b.timestamp).getTime() > entryTime).length;
      if (barsSinceEntry < minBars) return 'none';
    }

    const px = snapToTick(lastPrice);
    const { direction: dir, entryPrice } = this.currentPosition;

    const seed = this.fixedTrail.entryATR;
    const atrLive = Number.isFinite(_atrNow) && _atrNow > 0 ? _atrNow : (this.calculateATR() || seed);

    // Optional live compression to avoid runaway ATR-inflation trails
    let shrink = 1.0;
    if (Number.isFinite(atrLive) && atrLive > seed * 1.3) {
      shrink = Math.max(seed / atrLive, 0.5);
    }

    const offPts = this.fixedTrail.offPts * shrink;
    const actPts = this.fixedTrail.actPts * shrink;

    const reachedActivation =
      (dir === 'long' && (px - entryPrice) >= actPts) ||
      (dir === 'short' && (entryPrice - px) >= actPts);

    if (!reachedActivation) {
      // keep stops snapped
      this.trailingStopLevel = snapStop(this.trailingStopLevel, dir);
      this.currentPosition.stopLoss = this.trailingStopLevel;

      if ((dir === 'long' && px <= this.trailingStopLevel) ||
          (dir === 'short' && px >= this.trailingStopLevel)) {
        return 'hitTrail';
      }
      return 'none';
    }

    if (dir === 'long') {
      const candidate = snapStop(px - offPts, 'long');
      if (candidate > this.trailingStopLevel) this.trailingStopLevel = candidate;
      this.currentPosition.stopLoss = this.trailingStopLevel;
      if (px <= this.trailingStopLevel) return 'hitTrail';
    } else {
      const candidate = snapStop(px + offPts, 'short');
      if (candidate < this.trailingStopLevel) this.trailingStopLevel = candidate;
      this.currentPosition.stopLoss = this.trailingStopLevel;
      if (px >= this.trailingStopLevel) return 'hitTrail';
    }
    return 'none';
  }
}