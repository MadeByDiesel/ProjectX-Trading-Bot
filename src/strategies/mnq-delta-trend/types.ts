
// === Strategy configuration (Pine-parity) ===
export interface StrategyConfig {
  // SYMBOL / SESSION
  symbol: string;
  tradingStartTime: string; // e.g. '9:30' ET
  tradingEndTime: string;   // e.g. '16:00' ET

  // DELTA
  deltaSMALength: number;
  deltaSpikeThreshold: number;   // absolute threshold (Pine uses signed volume)
  deltaSurgeMultiplier: number;
  breakoutLookbackBars: number;
  deltaSlopeExitLength: number;

  // EMA (LTF + HTF)
  emaLength: number;             // LTF EMA length (3-minute)
  useEmaFilter: boolean;
  htfEMALength: number;          // HTF EMA length
  higherTimeframe: number;       // HTF in minutes (e.g. 15)

  // ATR / EXITS
  atrProfitMultiplier: number;
  atrStopLossMultiplier: number;
  minAtrToTrade: number;
  minBarsBeforeExit: number;

  // TRAILING STOP (ATR-based; Pine parity)
  useTrailingStop: boolean;
  trailActivationATR: number;
  trailOffsetATR: number;

  // POSITION SIZING
  contractQuantity: number;

  // RISK (kept for app-level risk management; not Pine logic)
  dailyProfitTarget: number;
  maxTotalDrawdown: number;
  maxDailyDrawdown: number;

  // Pine parity helpers
  requireDelta?: boolean; // if true, bar.delta must be provided (else hold)
  deltaScale?: number;    // scale factor to match Pine’s delta magnitude (default 1)

  htfUseForming?: boolean; 
  sendWebhook: boolean;     // toggle sending webhooks
  webhookUrl: string;       // destination URL (empty => disabled)
  
   // Intra-bar detection settings
  useIntraBarDetection?: boolean;           // Enable/disable intra-bar signals
  intraBarCheckIntervalMs?: number;         // How often to check during bar (default: 100ms)
  intraBarMinAccumulationMs?: number;       // Min time before first check (default: 5000ms = 5 seconds)
  intraBarConfirmationChecks?: number;      // Consecutive checks required (default: 3)
  intraBarConfirmationWindowMs?: number;    // Time window for confirmations (default: 500ms)
}

// === Bar / Market / Signal types used by calculator & trader ===
export interface BarData {
  timestamp: string; // ISO
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta?: number;    // signed volume for Pine parity
}

export interface MarketState {
  // Optional current price snapshot for UI/logging
  currentPrice?: number;

  // Calculator-populated
  atr: number;
  higherTimeframeTrend: 'bullish' | 'bearish' | 'neutral';
  deltaCumulative: number;

  // Optional history cache (some callers don’t use it)
  previousBars?: BarData[];
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
  direction: 'long' | 'short' | 'none';
  entryTime: number; // epoch ms
}
