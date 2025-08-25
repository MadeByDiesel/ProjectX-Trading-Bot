import { BarData, MarketState, StrategyConfig, TradeSignal } from './types';
import { TechnicalCalculator } from '../../utils/technical';

export class MNQDeltaTrendCalculator {
  private config: StrategyConfig;
  private technical: TechnicalCalculator;
  private bars3min: BarData[] = [];
  private bars15min: BarData[] = [];
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

  processNewBar(bar: BarData, marketState: MarketState): TradeSignal {
    if (!this.isWarmUpProcessed) {
      console.debug('Warm-up in progress, holding');
      return { signal: 'hold', reason: 'Warm-up in progress', confidence: 0 };
    }

    // Temporary debug - will be removed
    console.debug(`Processing bar: ${bar.timestamp} C:${bar.close} Δ:${bar.delta || 0}`);

    this.bars3min.push(bar);
    if (this.bars3min.length > 100) this.bars3min.shift();
    this.updateHigherTimeframeBars(bar);

    const atr = this.calculateATR();
    const trend = this.determineTrend();
    const deltaSignal = this.analyzeDelta(bar);
    const isBreakout = this.checkBreakout();

    marketState.atr = atr;
    marketState.higherTimeframeTrend = trend;
    marketState.deltaCumulative += bar.delta || 0;

    // Temporary debug - will be removed
    console.debug(`ATR: ${atr}, Trend: ${trend}, Breakout: ${isBreakout}`);

    // Check exits first (trailing stop, min bars, etc.)
    const exitSignal = this.checkExitConditions(bar, marketState);
    if (exitSignal) {
      console.debug(`Exit signal: ${exitSignal.signal}, Reason: ${exitSignal.reason}`);
      return exitSignal;
    }

    // Then check entries
    const signal = this.generateSignal(bar, marketState, deltaSignal, isBreakout);
    console.debug(`Final signal: ${signal.signal}, Reason: ${signal.reason}`);
    return signal;
  }

  private updateHigherTimeframeBars(bar: BarData): void {
    const last15minBar = this.bars15min[this.bars15min.length - 1];
    const barTime = new Date(bar.timestamp);
    const barMinutes = barTime.getMinutes();

    if (!last15minBar || barMinutes % this.config.higherTimeframe === 0) {
      this.bars15min.push({ ...bar });
    } else {
      last15minBar.high = Math.max(last15minBar.high, bar.high);
      last15minBar.low = Math.min(last15minBar.low, bar.low);
      last15minBar.close = bar.close;
      last15minBar.volume += bar.volume;
      if (bar.delta) last15minBar.delta = (last15minBar.delta || 0) + bar.delta;
    }

    if (this.bars15min.length > 50) this.bars15min.shift();
  }

  private calculateATR(): number {
    if (this.bars3min.length < 14 + 1) return 0; // Using standard 14-period ATR
    const recentBars = this.bars3min.slice(-15);
    return this.technical.calculateATR(recentBars, 14);
  }

  private calculateDeltaSMA(): number {
    if (this.bars3min.length < this.config.deltaSMALength) return 0;
    const recentBars = this.bars3min.slice(-this.config.deltaSMALength);
    const deltas = recentBars.map(b => b.delta || 0);
    return deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
  }

  private determineTrend(): 'bullish' | 'bearish' | 'neutral' {
    if (this.bars15min.length < 5) return 'neutral';

    const recentBars = this.bars15min.slice(-5);
    const closes = recentBars.map(b => b.close);
    const priceChange = closes[closes.length - 1] - closes[0];

    // Apply HTF EMA filter if enabled
    if (this.config.useEmaFilter) {
      const htfEMA = this.technical.calculateEMA(
        this.bars15min.map(b => b.close),
        this.config.htfEMALength
      );
      if (htfEMA.length === 0) return 'neutral';
      const currentPrice = this.bars15min[this.bars15min.length - 1].close;
      return currentPrice > htfEMA[htfEMA.length - 1] ? 'bullish' : 'bearish';
    }

    return priceChange > 0 ? 'bullish' : priceChange < 0 ? 'bearish' : 'neutral';
  }

  private analyzeDelta(bar: BarData): { strongBuy: boolean, strongSell: boolean } {
    if (!bar.delta) return { strongBuy: false, strongSell: false };

    const deltaSMA = this.calculateDeltaSMA();
    const surgeThreshold = deltaSMA * this.config.deltaSurgeMultiplier; // 1.4 multiplier

    const strongBuy = bar.delta > surgeThreshold && bar.delta > this.config.deltaSpikeThreshold;
    const strongSell = bar.delta < -surgeThreshold && bar.delta < -this.config.deltaSpikeThreshold;

    return { strongBuy, strongSell };
  }

  private checkBreakout(): boolean {
    if (this.bars3min.length < this.config.breakoutLookbackBars) return false;
    const recentBars = this.bars3min.slice(-this.config.breakoutLookbackBars);
    const currentHigh = Math.max(...recentBars.map(b => b.high));
    const currentLow = Math.min(...recentBars.map(b => b.low));
    const currentBar = this.bars3min[this.bars3min.length - 1];

    return currentBar.high > currentHigh || currentBar.low < currentLow;
  }

  private checkExitConditions(bar: BarData, marketState: MarketState): TradeSignal | null {
    if (!this.currentPosition) return null;

    const { entryPrice, entryTime, direction } = this.currentPosition;
    const barsInTrade = this.bars3min.filter(b => 
      new Date(b.timestamp).getTime() > entryTime
    ).length;

    // Check min bars before exit
    if (barsInTrade < this.config.minBarsBeforeExit) {
      return null;
    }

    // Check trailing stop
    if (this.config.useTrailingStop) {
      const trailSignal = this.checkTrailingStop(bar, direction);
      if (trailSignal) return trailSignal;
    }

    // Check delta slope exit
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

  private generateSignal(bar: BarData, marketState: MarketState, deltaSignal: any, isBreakout: boolean): TradeSignal {
    const { strongBuy, strongSell } = deltaSignal;

    // Temporary debug
    console.debug(`Signal gen - StrongBuy: ${strongBuy}, StrongSell: ${strongSell}, HTF Trend: ${marketState.higherTimeframeTrend}, Breakout: ${isBreakout}`);

    // Check minimum ATR to trade
    if (marketState.atr < this.config.minAtrToTrade) {
      console.debug('ATR too low for trading');
      return { signal: 'hold', reason: 'ATR too low for trading', confidence: 0 };
    }

    if (strongBuy && marketState.higherTimeframeTrend === 'bullish' && isBreakout) {
      console.debug('BUY SIGNAL: Strong delta surge with bullish HTF trend and breakout');
      return { 
        signal: 'buy', 
        reason: `Strong delta surge (+${bar.delta}) with bullish HTF trend and breakout`,
        confidence: 0.9
      };
    }

    if (strongSell && marketState.higherTimeframeTrend === 'bearish' && isBreakout) {
      console.debug('SELL SIGNAL: Strong delta surge with bearish HTF trend and breakout');
      return { 
        signal: 'sell', 
        reason: `Strong delta surge (${bar.delta}) with bearish HTF trend and breakout`,
        confidence: 0.9
      };
    }

    console.debug('No strong signal conditions met');
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
    this.trailingStopLevel = direction === 'long' ? entryPrice : entryPrice;
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

// import { BarData, MarketState, StrategyConfig, TradeSignal } from './types';
// import { TechnicalCalculator } from '../../utils/technical';

// export class MNQDeltaTrendCalculator {
//   private config: StrategyConfig;
//   private technical: TechnicalCalculator;
//   private bars3min: BarData[] = [];
//   private bars15min: BarData[] = [];
//   private isWarmUpProcessed: boolean = false;
//   private currentPosition: { entryPrice: number; entryTime: number; direction: 'long' | 'short' } | null = null;
//   private trailingStopLevel: number = 0;

//   constructor(config: StrategyConfig) {
//     this.config = config;
//     this.technical = new TechnicalCalculator();
//   }

//   processWarmUpBar(bar: BarData, timeframe: '3min' | '15min'): void {
//     if (timeframe === '3min') {
//       this.bars3min.push(bar);
//       if (this.bars3min.length > 100) this.bars3min.shift();
//     } else {
//       this.updateHigherTimeframeBars(bar);
//     }
//   }

//   completeWarmUp(): void {
//     if (this.bars3min.length >= 20 && this.bars15min.length >= 5) {
//       this.isWarmUpProcessed = true;
//       this.calculateATR();
//       this.determineTrend();
//     }
//   }

//   processNewBar(bar: BarData, marketState: MarketState): TradeSignal {
//     if (!this.isWarmUpProcessed) {
//       return { signal: 'hold', reason: 'Warm-up in progress', confidence: 0 };
//     }

//     this.bars3min.push(bar);
//     if (this.bars3min.length > 100) this.bars3min.shift();
//     this.updateHigherTimeframeBars(bar);

//     const atr = this.calculateATR();
//     const trend = this.determineTrend();
//     const deltaSignal = this.analyzeDelta(bar);
//     const isBreakout = this.checkBreakout();

//     marketState.atr = atr;
//     marketState.higherTimeframeTrend = trend;
//     marketState.deltaCumulative += bar.delta || 0;

//     // Check exits first (trailing stop, min bars, etc.)
//     const exitSignal = this.checkExitConditions(bar, marketState);
//     if (exitSignal) return exitSignal;

//     // Then check entries
//     return this.generateSignal(bar, marketState, deltaSignal, isBreakout);
//   }

//   private updateHigherTimeframeBars(bar: BarData): void {
//     const last15minBar = this.bars15min[this.bars15min.length - 1];
//     const barTime = new Date(bar.timestamp);
//     const barMinutes = barTime.getMinutes();

//     if (!last15minBar || barMinutes % this.config.higherTimeframe === 0) {
//       this.bars15min.push({ ...bar });
//     } else {
//       last15minBar.high = Math.max(last15minBar.high, bar.high);
//       last15minBar.low = Math.min(last15minBar.low, bar.low);
//       last15minBar.close = bar.close;
//       last15minBar.volume += bar.volume;
//       if (bar.delta) last15minBar.delta = (last15minBar.delta || 0) + bar.delta;
//     }

//     if (this.bars15min.length > 50) this.bars15min.shift();
//   }

//   private calculateATR(): number {
//     if (this.bars3min.length < 14 + 1) return 0; // Using standard 14-period ATR
//     const recentBars = this.bars3min.slice(-15);
//     return this.technical.calculateATR(recentBars, 14);
//   }

//   private calculateDeltaSMA(): number {
//     if (this.bars3min.length < this.config.deltaSMALength) return 0;
//     const recentBars = this.bars3min.slice(-this.config.deltaSMALength);
//     const deltas = recentBars.map(b => b.delta || 0);
//     return deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
//   }

//   private determineTrend(): 'bullish' | 'bearish' | 'neutral' {
//     if (this.bars15min.length < 5) return 'neutral';

//     const recentBars = this.bars15min.slice(-5);
//     const closes = recentBars.map(b => b.close);
//     const priceChange = closes[closes.length - 1] - closes[0];

//     // Apply HTF EMA filter if enabled
//     if (this.config.useEmaFilter) {
//       const htfEMA = this.technical.calculateEMA(
//         this.bars15min.map(b => b.close),
//         this.config.htfEMALength
//       );
//       if (htfEMA.length === 0) return 'neutral';
//       const currentPrice = this.bars15min[this.bars15min.length - 1].close;
//       return currentPrice > htfEMA[htfEMA.length - 1] ? 'bullish' : 'bearish';
//     }

//     return priceChange > 0 ? 'bullish' : priceChange < 0 ? 'bearish' : 'neutral';
//   }

//   private analyzeDelta(bar: BarData): { strongBuy: boolean, strongSell: boolean } {
//     if (!bar.delta) return { strongBuy: false, strongSell: false };

//     const deltaSMA = this.calculateDeltaSMA();
//     const surgeThreshold = deltaSMA * this.config.deltaSurgeMultiplier; // 1.4 multiplier

//     const strongBuy = bar.delta > surgeThreshold && bar.delta > this.config.deltaSpikeThreshold;
//     const strongSell = bar.delta < -surgeThreshold && bar.delta < -this.config.deltaSpikeThreshold;

//     return { strongBuy, strongSell };
//   }

//   private checkBreakout(): boolean {
//     if (this.bars3min.length < this.config.breakoutLookbackBars) return false;
//     const recentBars = this.bars3min.slice(-this.config.breakoutLookbackBars);
//     const currentHigh = Math.max(...recentBars.map(b => b.high));
//     const currentLow = Math.min(...recentBars.map(b => b.low));
//     const currentBar = this.bars3min[this.bars3min.length - 1];

//     return currentBar.high > currentHigh || currentBar.low < currentLow;
//   }

//   private checkExitConditions(bar: BarData, marketState: MarketState): TradeSignal | null {
//     if (!this.currentPosition) return null;

//     const { entryPrice, entryTime, direction } = this.currentPosition;
//     const barsInTrade = this.bars3min.filter(b => 
//       new Date(b.timestamp).getTime() > entryTime
//     ).length;

//     // Check min bars before exit
//     if (barsInTrade < this.config.minBarsBeforeExit) {
//       return null;
//     }

//     // Check trailing stop
//     if (this.config.useTrailingStop) {
//       const trailSignal = this.checkTrailingStop(bar, direction);
//       if (trailSignal) return trailSignal;
//     }

//     // Check delta slope exit
//     const deltaSlopeSignal = this.checkDeltaSlopeExit(marketState, direction);
//     if (deltaSlopeSignal) return deltaSlopeSignal;

//     return null;
//   }

//   private checkTrailingStop(bar: BarData, direction: 'long' | 'short'): TradeSignal | null {
//     const atr = this.calculateATR();
//     const activationDistance = atr * this.config.trailActivationATR;
//     const offsetDistance = atr * this.config.trailOffsetATR;

//     if (direction === 'long') {
//       if (bar.close > this.trailingStopLevel + activationDistance) {
//         this.trailingStopLevel = bar.close - offsetDistance;
//       }
//       if (bar.close <= this.trailingStopLevel) {
//         return { signal: 'sell', reason: 'Trailing stop hit', confidence: 0.9 };
//       }
//     } else {
//       if (bar.close < this.trailingStopLevel - activationDistance) {
//         this.trailingStopLevel = bar.close + offsetDistance;
//       }
//       if (bar.close >= this.trailingStopLevel) {
//         return { signal: 'buy', reason: 'Trailing stop hit', confidence: 0.9 };
//       }
//     }

//     return null;
//   }

//   private checkDeltaSlopeExit(marketState: MarketState, direction: 'long' | 'short'): TradeSignal | null {
//     if (this.bars3min.length < this.config.deltaSlopeExitLength) return null;

//     const recentBars = this.bars3min.slice(-this.config.deltaSlopeExitLength);
//     const deltas = recentBars.map(b => b.delta || 0);
//     const slope = this.technical.calculateSlope(deltas);

//     if (direction === 'long' && slope < 0) {
//       return { signal: 'sell', reason: 'Delta slope turning negative', confidence: 0.7 };
//     }
//     if (direction === 'short' && slope > 0) {
//       return { signal: 'buy', reason: 'Delta slope turning positive', confidence: 0.7 };
//     }

//     return null;
//   }

//   private generateSignal(bar: BarData, marketState: MarketState, deltaSignal: any, isBreakout: boolean): TradeSignal {
//     const { strongBuy, strongSell } = deltaSignal;

//     // Check minimum ATR to trade
//     if (marketState.atr < this.config.minAtrToTrade) {
//       return { signal: 'hold', reason: 'ATR too low for trading', confidence: 0 };
//     }

//     if (strongBuy && marketState.higherTimeframeTrend === 'bullish' && isBreakout) {
//       return { 
//         signal: 'buy', 
//         reason: `Strong delta surge (+${bar.delta}) with bullish HTF trend and breakout`,
//         confidence: 0.9
//       };
//     }

//     if (strongSell && marketState.higherTimeframeTrend === 'bearish' && isBreakout) {
//       return { 
//         signal: 'sell', 
//         reason: `Strong delta surge (${bar.delta}) with bearish HTF trend and breakout`,
//         confidence: 0.9
//       };
//     }

//     return { signal: 'hold', reason: 'No strong signal', confidence: 0 };
//   }

//   calculatePositionSize(currentPrice: number, atr: number, accountBalance: number): number {
//     const riskAmount = accountBalance * 0.01; // 1% risk per trade
//     const riskPerContract = atr * this.config.atrStopLossMultiplier * this.config.contractQuantity;
    
//     if (riskPerContract <= 0) return 1;
    
//     const positionSize = Math.floor(riskAmount / riskPerContract);
//     return Math.min(positionSize, this.config.contractQuantity || 10);
//   }

//   calculateStopLossTakeProfit(entryPrice: number, direction: 'long' | 'short', atr: number): 
//     { stopLoss: number, takeProfit: number } {
    
//     const stopLossDistance = atr * this.config.atrStopLossMultiplier;
//     const takeProfitDistance = atr * this.config.atrProfitMultiplier;

//     if (direction === 'long') {
//       return {
//         stopLoss: entryPrice - stopLossDistance,
//         takeProfit: entryPrice + takeProfitDistance
//       };
//     } else {
//       return {
//         stopLoss: entryPrice + stopLossDistance,
//         takeProfit: entryPrice - takeProfitDistance
//       };
//     }
//   }

//   private calculatePnL(entryPrice: number, exitPrice: number, quantity: number, direction: 'long' | 'short'): number {
//     if (direction === 'long') {
//       return (exitPrice - entryPrice) * quantity;
//     } else {
//       return (entryPrice - exitPrice) * quantity;
//     }
//   }
//   // Method to update position when trade is executed
//   setPosition(entryPrice: number, direction: 'long' | 'short'): void {
//     this.currentPosition = { entryPrice, entryTime: Date.now(), direction };
//     this.trailingStopLevel = direction === 'long' ? entryPrice : entryPrice;
//   }

//   clearPosition(): void {
//     this.currentPosition = null;
//     this.trailingStopLevel = 0;
//   }

//   getWarmUpStatus(): { isComplete: boolean; bars3min: number; bars15min: number } {
//     return {
//       isComplete: this.isWarmUpProcessed,
//       bars3min: this.bars3min.length,
//       bars15min: this.bars15min.length
//     };
//   }
// }

