import { BarData, MarketState, StrategyConfig, TradeSignal } from './types';
import { TechnicalCalculator } from '../../utils/technical';

export class MNQDeltaTrendCalculator {
  private config: StrategyConfig;
  private technical: TechnicalCalculator;

  // Closed bars storage
  private bars3min: BarData[] = [];
  private bars15min: BarData[] = [];

  // Bar-building state
  private current3mBucketStart: number | null = null;
  private working3mBar: BarData | null = null;

  private isWarmUpProcessed: boolean = false;
  private currentPosition: { entryPrice: number; entryTime: number; direction: 'long' | 'short' } | null = null;
  private trailingStopLevel: number = 0;

  constructor(config: StrategyConfig) {
    this.config = config;
    this.technical = new TechnicalCalculator();
  }

  processWarmUpBar(bar: BarData, timeframe: '3min' | '15min'): void {
    if (timeframe === '3min') {
      this.bars3min.push(bar);
      if (this.bars3min.length > 100) this.bars3min.shift();
    } else {
      this.updateHigherTimeframeBars(bar);
    }
  }

  completeWarmUp(): void {
    if (this.bars3min.length >= 20 && this.bars15min.length >= 5) {
      this.isWarmUpProcessed = true;
      this.calculateATR();
      this.determineTrend();
    }
  }

  /**
   * Accepts tick-like updates (OHLC are equal) but internally builds a true 3-minute bar.
   * Signals are only produced when a 3-minute bar closes (i.e., when the bucket rolls).
   */
  processNewBar(incoming: BarData, marketState: MarketState): TradeSignal {
    // Auto-complete warm-up if bar counts are sufficient
    if (!this.isWarmUpProcessed) {
      if (this.bars3min.length >= 20 && this.bars15min.length >= 5) {
        this.isWarmUpProcessed = true;
        this.calculateATR();
        this.determineTrend();
      } else {
        // not enough data yet, keep holding
        return { signal: 'hold', reason: 'Warm-up in progress', confidence: 0 };
      }
    }

    // --- 3-minute bucketing by provider timestamp ---
    const ts = new Date(incoming.timestamp).getTime();
    const bucketLenMs = 3 * 60 * 1000;
    const bucketStart = ts - (ts % bucketLenMs);

    // First tick we see
    if (this.current3mBucketStart === null || this.working3mBar === null) {
      this.current3mBucketStart = bucketStart;
      this.working3mBar = { ...incoming };
      return { signal: 'hold', reason: 'Building 3-minute bar', confidence: 0 };
    }

    // Same bucket: update the in-progress bar
    if (bucketStart === this.current3mBucketStart) {
      this.working3mBar.high = Math.max(this.working3mBar.high, incoming.high);
      this.working3mBar.low = Math.min(this.working3mBar.low, incoming.low);
      this.working3mBar.close = incoming.close;
      this.working3mBar.volume += incoming.volume || 0;
      if (typeof incoming.delta === 'number') {
        this.working3mBar.delta = (this.working3mBar.delta || 0) + incoming.delta;
      }
      return { signal: 'hold', reason: 'Building 3-minute bar', confidence: 0 };
    }

    // Bucket rolled: finalize previous bar, start a new working bar with current tick
    const closedBar = this.working3mBar;
    this.bars3min.push(closedBar);
    if (this.bars3min.length > 100) this.bars3min.shift();

    // HTF aggregation should use CLOSED 3m bar
    this.updateHigherTimeframeBars(closedBar);

    // Start new 3m bar with current tick
    this.current3mBucketStart = bucketStart;
    this.working3mBar = { ...incoming };

    // --- From here down, compute indicators & signals on the CLOSED bar only ---
    const atr = this.calculateATR();
    const trend = this.determineTrend();
    const deltaSignal = this.analyzeDelta(closedBar);
    const isBreakout = this.checkBreakout();

    marketState.atr = atr;
    marketState.higherTimeframeTrend = trend;
    marketState.deltaCumulative += closedBar.delta || 0;

    // Exits first (on closed bar)
    const exitSignal = this.checkExitConditions(closedBar, marketState);
    if (exitSignal) return exitSignal;

    // Entries next (on closed bar)
    return this.generateSignal(closedBar, marketState, deltaSignal, isBreakout);
  }

  private updateHigherTimeframeBars(bar: BarData): void {
    const last15minBar = this.bars15min[this.bars15min.length - 1];
    const barTime = new Date(bar.timestamp);
    const barMinutes = barTime.getMinutes();

    // Start a new HTF bar on multiples of configured higherTimeframe (e.g., 15)
    if (!last15minBar || barMinutes % this.config.higherTimeframe === 0) {
      this.bars15min.push({ ...bar });
    } else {
      last15minBar.high = Math.max(last15minBar.high, bar.high);
      last15minBar.low = Math.min(last15minBar.low, bar.low);
      last15minBar.close = bar.close;
      last15minBar.volume += bar.volume || 0;
      if (typeof bar.delta === 'number') {
        last15minBar.delta = (last15minBar.delta || 0) + bar.delta;
      }
    }

    if (this.bars15min.length > 50) this.bars15min.shift();
  }

  private calculateATR(): number {
    if (this.bars3min.length < 15) return 0; // 14-period ATR needs 15 bars
    const recentBars = this.bars3min.slice(-15);
    return this.technical.calculateATR(recentBars, 14);
  }

  private calculateDeltaSMA(): number {
    if (this.bars3min.length < this.config.deltaSMALength) return 0;
    const recentBars = this.bars3min.slice(-this.config.deltaSMALength);
    const deltas = recentBars.map(b => b.delta || 0);
    return deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
  }

  private determineTrend(): 'bullish' | 'bearish' | 'neutral' {
    if (this.bars15min.length < 5) return 'neutral';

    // EMA filter (preferred if enabled)
    if (this.config.useEmaFilter) {
      const htfEMA = this.technical.calculateEMA(
        this.bars15min.map(b => b.close),
        this.config.htfEMALength
      );
      if (htfEMA.length === 0) return 'neutral';
      const currentPrice = this.bars15min[this.bars15min.length - 1].close;
      return currentPrice > htfEMA[htfEMA.length - 1] ? 'bullish' : 'bearish';
    }

    // Fallback: simple 5-bar momentum
    const recentBars = this.bars15min.slice(-5);
    const closes = recentBars.map(b => b.close);
    const priceChange = closes[closes.length - 1] - closes[0];
    return priceChange > 0 ? 'bullish' : priceChange < 0 ? 'bearish' : 'neutral';
  }

  private analyzeDelta(bar: BarData): { strongBuy: boolean; strongSell: boolean } {
    if (typeof bar.delta !== 'number') return { strongBuy: false, strongSell: false };

    const deltaSMA = this.calculateDeltaSMA();
    const surgeThreshold = deltaSMA * this.config.deltaSurgeMultiplier;

    const strongBuy = bar.delta > surgeThreshold && bar.delta > this.config.deltaSpikeThreshold;
    const strongSell = bar.delta < -surgeThreshold && bar.delta < -this.config.deltaSpikeThreshold;

    return { strongBuy, strongSell };
  }

  private checkBreakout(): boolean {
    if (this.bars3min.length < this.config.breakoutLookbackBars) return false;
    const recentBars = this.bars3min.slice(-this.config.breakoutLookbackBars);
    const currentHigh = Math.max(...recentBars.map(b => b.high));
    const currentLow = Math.min(...recentBars.map(b => b.low));
    const lastClosed = this.bars3min[this.bars3min.length - 1];

    return lastClosed.high > currentHigh || lastClosed.low < currentLow;
  }

  private checkExitConditions(bar: BarData, marketState: MarketState): TradeSignal | null {
    if (!this.currentPosition) return null;

    const { entryTime, direction } = this.currentPosition;
    const barsInTrade = this.bars3min.filter(b => new Date(b.timestamp).getTime() > entryTime).length;

    // Enforce minimum bars in trade before allowing exits
    if (barsInTrade < this.config.minBarsBeforeExit) return null;

    // Trailing stop
    if (this.config.useTrailingStop) {
      const trailSignal = this.checkTrailingStop(bar, direction);
      if (trailSignal) return trailSignal;
    }

    // Delta slope exit
    const deltaSlopeSignal = this.checkDeltaSlopeExit(marketState, direction);
    if (deltaSlopeSignal) return deltaSlopeSignal;

    return null;
  }

  private checkTrailingStop(bar: BarData, direction: 'long' | 'short'): TradeSignal | null {
    const atr = this.calculateATR();
    const activationDistance = atr * this.config.trailActivationATR;
    const offsetDistance = atr * this.config.trailOffsetATR;

    if (direction === 'long') {
      if (bar.close > this.trailingStopLevel + activationDistance) {
        this.trailingStopLevel = bar.close - offsetDistance;
      }
      if (bar.close <= this.trailingStopLevel) {
        return { signal: 'sell', reason: 'Trailing stop hit', confidence: 0.9 };
      }
    } else {
      if (bar.close < this.trailingStopLevel - activationDistance) {
        this.trailingStopLevel = bar.close + offsetDistance;
      }
      if (bar.close >= this.trailingStopLevel) {
        return { signal: 'buy', reason: 'Trailing stop hit', confidence: 0.9 };
      }
    }

    return null;
  }

  private checkDeltaSlopeExit(marketState: MarketState, direction: 'long' | 'short'): TradeSignal | null {
    if (this.bars3min.length < this.config.deltaSlopeExitLength) return null;

    const recentBars = this.bars3min.slice(-this.config.deltaSlopeExitLength);
    const deltas = recentBars.map(b => b.delta || 0);
    const slope = this.technical.calculateSlope(deltas);

    if (direction === 'long' && slope < 0) {
      return { signal: 'sell', reason: 'Delta slope turning negative', confidence: 0.7 };
    }
    if (direction === 'short' && slope > 0) {
      return { signal: 'buy', reason: 'Delta slope turning positive', confidence: 0.7 };
    }

    return null;
  }

  private generateSignal(bar: BarData, marketState: MarketState, deltaSignal: { strongBuy: boolean; strongSell: boolean }, isBreakout: boolean): TradeSignal {
    const { strongBuy, strongSell } = deltaSignal;

    if (marketState.atr < this.config.minAtrToTrade) {
      return { signal: 'hold', reason: 'ATR too low for trading', confidence: 0 };
    }

    if (strongBuy && marketState.higherTimeframeTrend === 'bullish' && isBreakout) {
      return {
        signal: 'buy',
        reason: `Strong delta surge (+${bar.delta}) with bullish HTF trend and breakout`,
        confidence: 0.9
      };
    }

    if (strongSell && marketState.higherTimeframeTrend === 'bearish' && isBreakout) {
      return {
        signal: 'sell',
        reason: `Strong delta surge (${bar.delta}) with bearish HTF trend and breakout`,
        confidence: 0.9
      };
    }

    return { signal: 'hold', reason: 'No strong signal', confidence: 0 };
  }

  calculatePositionSize(currentPrice: number, atr: number, accountBalance: number): number {
    const riskAmount = accountBalance * 0.01; // 1% risk per trade
    const riskPerContract = atr * this.config.atrStopLossMultiplier * this.config.contractQuantity;

    if (riskPerContract <= 0) return 1;

    const positionSize = Math.floor(riskAmount / riskPerContract);
    return Math.min(positionSize, this.config.contractQuantity || 10);
  }

  calculateStopLossTakeProfit(entryPrice: number, direction: 'long' | 'short', atr: number):
    { stopLoss: number, takeProfit: number } {

    const stopLossDistance = atr * this.config.atrStopLossMultiplier;
    const takeProfitDistance = atr * this.config.atrProfitMultiplier;

    if (direction === 'long') {
      return {
        stopLoss: entryPrice - stopLossDistance,
        takeProfit: entryPrice + takeProfitDistance
      };
    } else {
      return {
        stopLoss: entryPrice + stopLossDistance,
        takeProfit: entryPrice - takeProfitDistance
      };
    }
  }

  private calculatePnL(entryPrice: number, exitPrice: number, quantity: number, direction: 'long' | 'short'): number {
    if (direction === 'long') {
      return (exitPrice - entryPrice) * quantity;
    } else {
      return (entryPrice - exitPrice) * quantity;
    }
  }

  // Method to update position when trade is executed
  setPosition(entryPrice: number, direction: 'long' | 'short'): void {
    this.currentPosition = { entryPrice, entryTime: Date.now(), direction };
    this.trailingStopLevel = entryPrice;
  }

  clearPosition(): void {
    this.currentPosition = null;
    this.trailingStopLevel = 0;
  }

  getWarmUpStatus(): { isComplete: boolean; bars3min: number; bars15min: number } {
    return {
      isComplete: this.isWarmUpProcessed,
      bars3min: this.bars3min.length,
      bars15min: this.bars15min.length
    };
  }
}
