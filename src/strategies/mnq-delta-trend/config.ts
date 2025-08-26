import { StrategyConfig } from './types';

export const MNQ_DELTA_TREND_CONFIG: StrategyConfig = {
    // === SYMBOL CONFIG ===
  symbol: 'MNQ', // Add this
  // === TIME FILTER ===
  tradingStartTime: '09:30',
  tradingEndTime: '16:00',
  
  // === DELTA CONFIGURATION ===
  deltaSMALength: 9,
  deltaSpikeThreshold: 450,
  deltaSurgeMultiplier: 1.4,
  breakoutLookbackBars: 50,
  deltaSlopeExitLength: 3,
  
  // === EMA CONFIGURATION ===
  emaLength: 11,
  useEmaFilter: true,
  htfEMALength: 17,
  higherTimeframe: 15,
  
  // === ATR & EXIT CONFIGURATION ===
  atrProfitMultiplier: 1.8,
  atrStopLossMultiplier: 1.2,
  minAtrToTrade: 8,
  minBarsBeforeExit: 0,
  
  // === TRAILING STOP CONFIGURATION ===
  useTrailingStop: true,
  trailActivationATR: 0.2,
  trailOffsetATR: 0.125,
  
  // === POSITION SIZING ===
  contractQuantity: 1,
  
  // === RISK MANAGEMENT ===
  dailyProfitTarget: 1500,
  maxTotalDrawdown: 2500,
  maxDailyDrawdown: 1000
};