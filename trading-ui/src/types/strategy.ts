
export interface Trade {
  id: string;
  entryTime: string;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number | null;
  pnl: number | null;
  reason: string;
  status: 'open' | 'closed';
  contract: string;
  quantity: number;
  fees?: number;        // Optional field
  orderId?: string;  
}

export interface PositionTrade {
  id: string;
  accountId: number;
  contractId: string;
  creationTimestamp: string;
  type: number; // 1=long, 2=short
  size: number;
  averagePrice: number;
  currentPrice?: number;
}

export interface StrategyConfig {
  symbol: string;
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

export interface Account {
  id: number;
  name: string;
  balance: number;
  canTrade: boolean;
  isVisible: boolean;
  simulated: boolean;
}

// For API responses
export interface ApiResponse<T> {
  success: boolean;
  errorCode?: number;
  errorMessage?: string;
  data?: T;
}

// For strategy status
export interface StrategyStatus {
  isRunning: boolean;
  currentAccount: Account | null;
  currentConfig: StrategyConfig;
  performance: {
    dailyPnl: number;
    totalPnl: number;
    winRate: number;
    tradesToday: number;
  };
}
