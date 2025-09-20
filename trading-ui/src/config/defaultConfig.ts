import { StrategyConfig } from '../types/strategy';

export const defaultStrategyConfig: StrategyConfig = {
  symbol: 'MNQ',
  // === TIME FILTER ===
  tradingStartTime: '09:30',
  tradingEndTime: '16:00',
  
  // === DELTA CONFIGURATION ===
  deltaSMALength: 20,                  // 14-period SMA for delta
  deltaSpikeThreshold: 450,            // OPTIMIZED: 450 (from 750 baseline)
  deltaSurgeMultiplier: 1.4,           // OPTIMIZED: 1.4 (not 8)
  breakoutLookbackBars: 20,            // OPTIMIZED: 99 bars lookback
  deltaSlopeExitLength: 3,             // 4-bar slope for exit
  
  // === EMA CONFIGURATION ===
  emaLength: 21,                        // 6-period EMA
  useEmaFilter: true,                  // Enable EMA filter
  htfEMALength: 7,                    // 20-period HTF EMA
  higherTimeframe: 15,                 // 60-minute higher timeframe
  
  // === ATR & EXIT CONFIGURATION ===
  atrProfitMultiplier:1.8,              // 4x ATR for profit target
  atrStopLossMultiplier: 0.3,            // 2x ATR for stop loss
  minAtrToTrade: 9,                   // Minimum 15 ATR to trade
  minBarsBeforeExit: 0,                // Minimum 8 bars in position
  
  // === TRAILING STOP CONFIGURATION ===
  useTrailingStop: true,               // Enable trailing stop
  trailActivationATR: .125,             // 1.5x ATR for trail activation
  trailOffsetATR: 0.05,                 // 0.5x ATR for trail offset
  
  // === POSITION SIZING ===
  contractQuantity: 1,                 // Default 1 contract
  
  // === RISK MANAGEMENT ===
  dailyProfitTarget: 1500,
  maxTotalDrawdown: 2500,
  maxDailyDrawdown: 2000
  
};
