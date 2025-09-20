import { StrategyConfig } from './types';

export const MNQ_DELTA_TREND_CONFIG: StrategyConfig = {
  // === SYMBOL CONFIG ===
  symbol: 'MNQ',

  // === TIME FILTER ===
  tradingStartTime: '09:30',
  tradingEndTime:   '15:55',

  // === DELTA CONFIGURATION (force easy entry) ===
  deltaSMALength: 20,           
  deltaSpikeThreshold: 550,    
  deltaSurgeMultiplier: 1.7,   
  breakoutLookbackBars: 30,    
  deltaSlopeExitLength: 3,     

  // === EMA CONFIGURATION ===
  emaLength: 21,            
  useEmaFilter: true,       
  htfEMALength: 21,
  higherTimeframe: 15,
  htfUseForming: false,

  // === ATR & EXIT CONFIGURATION ===
  atrProfitMultiplier: 1.0,    
  atrStopLossMultiplier: 1.2,  //0.3-0.5
  minAtrToTrade: 13,        
  minBarsBeforeExit: 1,

  // === TRAILING STOP CONFIGURATION ===
  useTrailingStop: true,    

  // === POSITION SIZING ===
  contractQuantity: 3,

  // === RISK MANAGEMENT ===
  dailyProfitTarget: 1500,
  maxTotalDrawdown: 2500,
  maxDailyDrawdown: 2500,

    // === TRAILING STOP CONFIGURATION ===
  trailActivationATR: 0.15,
  trailOffsetATR: 0.125,

  "requireDelta": true,                // set true only if you MUST have true delta from feed
  "deltaScale": 1,                      // set this to match Pine’s scale if your volume units differ

};

// src/strategies/mnq-delta-trend/config.ts
// export const MNQ_DELTA_TREND_CONFIG: StrategyConfig = {
//   // === SYMBOL CONFIG ===
//   symbol: 'MNQ',

//   // === TIME FILTER ===
//   tradingStartTime: '00:00', // Adjusted to 2:00 PM MDT for after-hours start (from 9:30)
//   tradingEndTime: '23:59',   // Adjusted to 8:00 PM MDT for after-hours end (from 16:00)

//   // === DELTA CONFIGURATION (force easy entry) ===
//   deltaSMALength: 20,           // Kept as is, short window for sensitivity
//   deltaSpikeThreshold: 1,     // Adjusted from 450 to 150 to match observed delta (171)
//   deltaSurgeMultiplier: 0.1,    // Kept as is, no extra filter
//   breakoutLookbackBars: 3,      // Reduced from 20 for quick after-hours breakouts (maps to breakoutLookbackBars)
//   deltaSlopeExitLength: 3,      // Kept as is, fast slope exit

//   // === EMA CONFIGURATION ===
//   emaLength: 21,                // Not directly used in trader.ts; keep for potential EMA logic
//   useEmaFilter: false,          // Disabled from true to remove HTF gating (maps to higherTimeframe logic)
//   htfEMALength: 7,              // Not directly used; keep for higher timeframe context
//   higherTimeframe: 15,          // Kept as is, 15-minute HTF

//   // === ATR & EXIT CONFIGURATION ===
//   atrProfitMultiplier: 1.8,     // Kept as is, quick TP (maps to takeProfitMultiplier)
//   atrStopLossMultiplier: 1.2,   // Kept as is, tight SL (maps to stopLossMultiplier)
//   minAtrToTrade: 0,             // Kept as is, permissive ATR gate
//   minBarsBeforeExit: 0,         // Kept as is, allows immediate exits

//   // === TRAILING STOP CONFIGURATION ===
//   useTrailingStop: false,       // Changed from true to simplify for after-hours
//   trailActivationATR: 0.2,      // Kept as is, for potential trailing stop
//   trailOffsetATR: 0.125,        // Kept as is, for potential trailing stop

//   // === POSITION SIZING ===
//   contractQuantity: 1,          // Kept as is; could map to positionSizeFactor if scaled

//   // === RISK MANAGEMENT ===
//   dailyProfitTarget: 1500,      // Kept as is
//   maxTotalDrawdown: 2500,       // Kept as is
//   maxDailyDrawdown: 2500,       // Kept as is

//   requireDelta: true,           // Kept as is, ensures delta usage
//   deltaScale: 1                 // Kept as is, matches Pine scale if applicable
// };
