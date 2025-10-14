import { StrategyConfig } from './types';

export const MNQ_DELTA_TREND_CONFIG: StrategyConfig = {
  // === SYMBOL CONFIG ===
  symbol: 'MNQ',

  // === TIME FILTER ===
  tradingStartTime: '09:30',
  tradingEndTime:   '16:00',

  // === DELTA CONFIGURATION (force easy entry) ===
  deltaSMALength: 20,           
  deltaSpikeThreshold: 900,   // 450 base 
  deltaSurgeMultiplier: 1.8,  // 1.4 base
  breakoutLookbackBars: 20,   // 20 base 
  deltaSlopeExitLength: 3,     

  // === EMA CONFIGURATION ===
  emaLength: 9,            
  useEmaFilter: true,       
  htfEMALength: 9,
  higherTimeframe: 15,
  htfUseForming: true,

  // === ATR & EXIT CONFIGURATION ===
  atrProfitMultiplier: 1.0,    
  atrStopLossMultiplier: 0.75,  //0.3-0.5
  minAtrToTrade: 12,        
  minBarsBeforeExit: 0,

  // === TRAILING STOP CONFIGURATION ===
  useTrailingStop: true,
  trailActivationATR: 0.125,
  trailOffsetATR: 0.125,

  // === POSITION SIZING ===
  contractQuantity: 1,

  // === RISK MANAGEMENT ===
  dailyProfitTarget: 1500,
  maxTotalDrawdown: 2500,
  maxDailyDrawdown: 2500,

  requireDelta: true,                // set true only if you MUST have true delta from feed
  deltaScale: 1,   

  sendWebhook: false,
  webhookUrl: 'http://192.168.4.170:8080/signal?secret=toast',
};
