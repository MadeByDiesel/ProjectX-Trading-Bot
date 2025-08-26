import { StrategyConfig } from './types';

// export const MNQ_DELTA_TREND_CONFIG: StrategyConfig = {
//     // === SYMBOL CONFIG ===
//   symbol: 'MNQ', // Add this
//   // === TIME FILTER ===
//   tradingStartTime: '09:30',
//   tradingEndTime: '16:00',
  
//   // === DELTA CONFIGURATION ===
//   deltaSMALength: 9,
//   deltaSpikeThreshold: 450,
//   deltaSurgeMultiplier: 1.4,
//   breakoutLookbackBars: 50,
//   deltaSlopeExitLength: 3,
  
//   // === EMA CONFIGURATION ===
//   emaLength: 11,
//   useEmaFilter: true,
//   htfEMALength: 17,
//   higherTimeframe: 15,
  
//   // === ATR & EXIT CONFIGURATION ===
//   atrProfitMultiplier: 1.8,
//   atrStopLossMultiplier: 1.2,
//   minAtrToTrade: 8,
//   minBarsBeforeExit: 0,
  
//   // === TRAILING STOP CONFIGURATION ===
//   useTrailingStop: true,
//   trailActivationATR: 0.2,
//   trailOffsetATR: 0.125,
  
//   // === POSITION SIZING ===
//   contractQuantity: 1,
  
//   // === RISK MANAGEMENT ===
//   dailyProfitTarget: 1500,
//   maxTotalDrawdown: 2500,
//   maxDailyDrawdown: 1000
// };


export const MNQ_DELTA_TREND_CONFIG: StrategyConfig = {
  // === SYMBOL CONFIG ===
  symbol: 'MNQ',

  // === TIME FILTER ===
  tradingStartTime: '09:30',
  tradingEndTime:   '16:00',

  // === DELTA CONFIGURATION (force easy entry) ===
  deltaSMALength: 3,           // short window, sensitive
  deltaSpikeThreshold: 1,      // very low threshold → almost any delta moves count
  deltaSurgeMultiplier: 1.0,   // no extra filter
  breakoutLookbackBars: 3,     // tiny lookback → breakouts easy to trigger
  deltaSlopeExitLength: 2,     // fast slope exit

  // === EMA CONFIGURATION ===
  emaLength: 3,                // tiny EMA filter
  useEmaFilter: false,         // disable filter (removes HTF gating)
  htfEMALength: 5,
  higherTimeframe: 15,

  // === ATR & EXIT CONFIGURATION ===
  atrProfitMultiplier: 0.5,    // quick TP
  atrStopLossMultiplier: 0.5,  // tight SL
  minAtrToTrade: 0.01,         // basically always passes ATR gate
  minBarsBeforeExit: 0,

  // === TRAILING STOP CONFIGURATION ===
  useTrailingStop: false,      // disable for simplicity

  // === POSITION SIZING ===
  contractQuantity: 1,

  // === RISK MANAGEMENT ===
  dailyProfitTarget: 999999,
  maxTotalDrawdown: 999999,
  maxDailyDrawdown: 999999,

    // === TRAILING STOP CONFIGURATION ===
  trailActivationATR: 0.2,
  trailOffsetATR: 0.125,

};
