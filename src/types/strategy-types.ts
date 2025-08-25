import { BarData } from './api-types';

export interface StrategyConfig {
  symbol: string;
  contractSize: number;
  tradingStartTime: string;
  tradingEndTime: string;
  primaryTimeframe: number;
  higherTimeframe: number;
  deltaThreshold: number;
  trendConfirmationBars: number;
  atrPeriod: number;
  atrMultiplier: number;
  maxPositionSize: number;
  riskPerTrade: number;
  stopLossATRMultiplier: number;
  takeProfitATRMultiplier: number;
  maxDailyLoss: number;
}

export interface PositionState {
  isInPosition: boolean;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  positionSize: number;
  direction: 'long' | 'short' | 'none';
  entryTime: number;
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