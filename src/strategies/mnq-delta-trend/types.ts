export interface StrategyConfig {
    // === SYMBOL CONFIG ===
  symbol: string; // Add this property
  // === TIME FILTER ===
  tradingStartTime: string;
  tradingEndTime: string;
  
  // === DELTA CONFIGURATION ===
  deltaSMALength: number;              // Delta SMA Length
  deltaSpikeThreshold: number;         // Delta Spike Threshold (absolute value)
  deltaSurgeMultiplier: number;        // Delta Surge Multiplier
  breakoutLookbackBars: number;        // Breakout lookback bars
  deltaSlopeExitLength: number;        // Delta Slope Exit Length
  
  // === EMA CONFIGURATION ===
  emaLength: number;                   // EMA length
  useEmaFilter: boolean;               // Use EMA filter checkbox
  htfEMALength: number;                // HTF EMA length
  higherTimeframe: number;             // Higher time frame (mins)
  
  // === ATR & EXIT CONFIGURATION ===
  atrProfitMultiplier: number;         // ATR profit multiplier
  atrStopLossMultiplier: number;       // ATR Stop Loss Multiplier
  minAtrToTrade: number;               // Min ATR to trade
  minBarsBeforeExit: number;           // Min Bars before exit
  
  // === TRAILING STOP CONFIGURATION ===
  useTrailingStop: boolean;            // Use Trailing Stop checkbox
  trailActivationATR: number;          // Trail activation (ATR Multiplier)
  trailOffsetATR: number;              // Trail offset (ATR Multiplier)
  
  // === POSITION SIZING ===
  contractQuantity: number;            // Contract quantity
  
  // === RISK MANAGEMENT ===
  dailyProfitTarget: number;
  maxTotalDrawdown: number;
  maxDailyDrawdown: number;
}

// Keep your existing other types but update StrategyConfig
export interface BarData {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta?: number;
}

export interface MarketState {
  currentPrice: number;
  atr: number;
  higherTimeframeTrend: 'bullish' | 'bearish' | 'neutral';
  deltaCumulative: number;
  previousBars: BarData[];
}

export interface TradeSignal {
  signal: 'buy' | 'sell' | 'hold';
  reason: string;
  confidence: number;
}

export interface PositionState {
  isInPosition: boolean;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  positionSize: number;
  direction: 'long' | 'short' | 'none'; // Add 'none' to allowed values
  entryTime: number;
}