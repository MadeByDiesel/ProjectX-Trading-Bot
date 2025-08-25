import { BarData } from '../strategies/mnq-delta-trend/types';

export class TechnicalCalculator {
  
  /**
   * Calculate Average True Range (ATR)
   */
  calculateATR(bars: BarData[], period: number): number {
    if (bars.length < period + 1) return 0;

    let totalATR = 0;
    
    for (let i = 1; i <= period; i++) {
      const currentBar = bars[bars.length - i];
      const previousBar = bars[bars.length - i - 1];
      
      const trueRange = Math.max(
        currentBar.high - currentBar.low,
        Math.abs(currentBar.high - previousBar.close),
        Math.abs(currentBar.low - previousBar.close)
      );
      
      totalATR += trueRange;
    }

    return totalATR / period;
  }

  /**
   * Calculate Exponential Moving Average (EMA)
   */
  calculateEMA(prices: number[], period: number): number[] {
    if (prices.length < period) return [];
    
    const k = 2 / (period + 1);
    const emaValues: number[] = [];
    
    // Start with SMA for the first value
    let sma = 0;
    for (let i = 0; i < period; i++) {
      sma += prices[i];
    }
    sma /= period;
    emaValues.push(sma);
    
    // Calculate EMA for remaining values
    for (let i = period; i < prices.length; i++) {
      const ema = prices[i] * k + emaValues[emaValues.length - 1] * (1 - k);
      emaValues.push(ema);
    }
    
    return emaValues;
  }

  /**
   * Calculate slope of values using linear regression
   */
  calculateSlope(values: number[]): number {
    if (values.length < 2) return 0;
    
    const n = values.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumXX += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    return slope;
  }

  /**
   * Check if price is making higher highs and higher lows
   */
  isMakingHigherHighsLows(highs: number[], lows: number[]): boolean {
    if (highs.length < 2 || lows.length < 2) return false;
    return highs[highs.length - 1] > highs[highs.length - 2] &&
           lows[lows.length - 1] > lows[lows.length - 2];
  }

  /**
   * Check if price is making lower highs and lower lows
   */
  isMakingLowerHighsLows(highs: number[], lows: number[]): boolean {
    if (highs.length < 2 || lows.length < 2) return false;
    return highs[highs.length - 1] < highs[highs.length - 2] &&
           lows[lows.length - 1] < lows[lows.length - 2];
  }

  /**
   * Calculate Simple Moving Average (SMA)
   */
  calculateSMA(values: number[], period: number): number {
    if (values.length < period) return 0;
    
    const recentValues = values.slice(-period);
    const sum = recentValues.reduce((total, value) => total + value, 0);
    return sum / period;
  }

  /**
   * Calculate Relative Strength Index (RSI)
   */
  calculateRSI(prices: number[], period: number = 14): number {
    if (prices.length < period + 1) return 50;
    
    let gains = 0;
    let losses = 0;
    
    for (let i = prices.length - period; i < prices.length - 1; i++) {
      const change = prices[i + 1] - prices[i];
      if (change > 0) {
        gains += change;
      } else {
        losses += Math.abs(change);
      }
    }
    
    const avgGain = gains / period;
    const avgLoss = losses / period;
    
    if (avgLoss === 0) return 100;
    
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }
}