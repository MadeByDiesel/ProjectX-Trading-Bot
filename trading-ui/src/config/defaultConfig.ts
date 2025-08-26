import { StrategyConfig } from '../types/strategy';

export const defaultStrategyConfig: StrategyConfig = {
  symbol: 'MNQ',
  // === TIME FILTER ===
  tradingStartTime: '09:30',
  tradingEndTime: '16:00',
  
  // // === DELTA CONFIGURATION ===
  // deltaSMALength: 9,                  // 14-period SMA for delta
  // deltaSpikeThreshold: 450,            // OPTIMIZED: 450 (from 750 baseline)
  // deltaSurgeMultiplier: 1.4,           // OPTIMIZED: 1.4 (not 8)
  // breakoutLookbackBars: 99,            // OPTIMIZED: 99 bars lookback
  // deltaSlopeExitLength: 3,             // 4-bar slope for exit
  
  // // === EMA CONFIGURATION ===
  // emaLength: 11,                        // 6-period EMA
  // useEmaFilter: true,                  // Enable EMA filter
  // htfEMALength: 17,                    // 20-period HTF EMA
  // higherTimeframe: 15,                 // 60-minute higher timeframe
  
  // // === ATR & EXIT CONFIGURATION ===
  // atrProfitMultiplier:1.8,              // 4x ATR for profit target
  // atrStopLossMultiplier: 1.2,            // 2x ATR for stop loss
  // minAtrToTrade: 8,                   // Minimum 15 ATR to trade
  // minBarsBeforeExit: 0,                // Minimum 8 bars in position
  
  // // === TRAILING STOP CONFIGURATION ===
  // useTrailingStop: true,               // Enable trailing stop
  // trailActivationATR: .25,             // 1.5x ATR for trail activation
  // trailOffsetATR: 0.125,                 // 0.5x ATR for trail offset
  
  // // === POSITION SIZING ===
  // contractQuantity: 1,                 // Default 1 contract
  
  // // === RISK MANAGEMENT ===
  // dailyProfitTarget: 1500,
  // maxTotalDrawdown: 2500,
  // maxDailyDrawdown: 2000

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