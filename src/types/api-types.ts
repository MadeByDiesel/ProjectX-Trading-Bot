export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
  environment?: 'demo' | 'live';
}

export interface AccessToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface Account {
  id: number;        // Changed from string to number based on API docs
  name: string;
  balance: number;
  canTrade: boolean; // ADD THIS - from API documentation
  isVisible: boolean; // ADD THIS - from API documentation
  simulated: boolean; // ADD THIS - from API documentation
}

export interface AccountSearchRequest {
  accountNumber?: string;
  live?: boolean;
}

export interface AccountSearchResponse {
  success: boolean;
  errorCode: number;
  errorMessage: string;
  accounts: Account[];
}

export interface LoginCredentials {
  userName: string;    // ← Should be userName, not login
  apiKey: string;      // ← Should be apiKey, not password
}
export interface AuthResponse {
  success: boolean;
  errorCode: number;
  errorMessage: string;
  token: string;
}

export interface ContractSearchRequest {
  searchText: string;
  live: boolean;
}

export interface Contract {
  id: string;
  name: string;
  description: string;
  tickSize: number;
  tickValue: number;
  activeContract: boolean;
  symbolId: string;
}

export interface ContractSearchResponse {
  contracts: Contract[];
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
}

export interface ContractSearchByIdRequest {
  contractId: string;
}

export interface ContractSearchByIdResponse {
  contract: Contract;
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
}

export interface BarData {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta?: number;
}

export interface RetrieveBarsRequest {
  contractId: string;
  live: boolean;
  startTime: string;
  endTime: string;
  unit: number;
  unitNumber: number;
  limit: number;
  includePartialBar: boolean;
}

export interface RetrieveBarsResponse {
  bars: BarData[];
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
}

export interface ApiError {
  code: number;
  message: string;
  timestamp: string;
}

export interface ApiResponse<T> {
  data?: T;
  error?: ApiError;
  timestamp: string;
}

export interface ProjectXConfig {
  apiKey: string;
  userName: string;
  baseURL: string;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  timestamp: string;
}

export interface MarketData {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  timestamp: string;
  delta?: number;
}

export interface ApiResponseBase {
  success: boolean;
  errorCode: number;
  errorMessage: string;
}

export interface Order {
  id: number;
  accountId: number;
  contractId: string;
  symbolId: string;
  creationTimestamp: string;
  updateTimestamp: string;
  status: number;
  type: number;
  side: number;
  size: number;
  limitPrice: number;
  stopPrice: number;
  fillVolume: number;
  filledPrice: number;
  customTag: string;
}

export interface Position {
  id: number;
  accountId: number;
  contractId: string;
  creationTimestamp: string;
  type: number;
  size: number;
  averagePrice: number;
}

export interface OrderSearchResponse extends ApiResponseBase {
  orders: Order[];
}

export interface OrderPlaceResponse extends ApiResponseBase {
  orderId: number;
}

export interface PositionSearchResponse extends ApiResponseBase {
  positions: Position[];
}

// SignalR Real-time Types
export interface GatewayQuote {
  symbol: string;
  symbolName: string;
  lastPrice: number;
  bestBid: number;
  bestAsk: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  lastUpdated: string;
  timestamp: string;
}

export interface GatewayTrade {
  symbolId: string;
  price: number;
  timestamp: string;
  type: TradeLogType;
  volume: number;
}

export interface GatewayDepth {
  timestamp: string;
  type: DomType;
  price: number;
  volume: number;
  currentVolume: number;
}

export interface GatewayUserAccount {
  id: number;
  name: string;
  balance: number;
  canTrade: boolean;
  isVisible: boolean;
  simulated: boolean;
}

export interface GatewayUserPosition {
  id: number;
  accountId: number;
  contractId: string;
  creationTimestamp: string;
  type: number;
  size: number;
  averagePrice: number;
}

export interface GatewayUserOrder {
  id: number;
  accountId: number;
  contractId: string;
  symbolId: string;
  creationTimestamp: string;
  updateTimestamp: string;
  status: number;
  type: number;
  side: number;
  size: number;
  limitPrice: number;
  stopPrice: number | null;
  fillVolume: number;
  filledPrice: number | null;
  customTag: string;
}

export interface GatewayUserTrade {
  id: number;
  accountId: number;
  contractId: string;
  creationTimestamp: string;
  price: number;
  profitAndLoss: number;
  fees: number;
  side: number;
  size: number;
  voided: boolean;
  orderId: number;
}

// Enums
export enum OrderType {
  Unknown = 0,
  Limit = 1,
  Market = 2,
  StopLimit = 3,
  Stop = 4,
  TrailingStop = 5,
  JoinBid = 6,
  JoinAsk = 7
}

export enum OrderSide {
  Bid = 0,
  Ask = 1
}

export enum OrderStatus {
  None = 0,
  Open = 1,
  Filled = 2,
  Cancelled = 3,
  Expired = 4,
  Rejected = 5,
  Pending = 6
}

export enum PositionType {
  Undefined = 0,
  Long = 1,
  Short = 2
}

export enum TradeLogType {
  Buy = 0,
  Sell = 1
}

export enum DomType {
  Unknown = 0,
  Ask = 1,
  Bid = 2,
  BestAsk = 3,
  BestBid = 4,
  Trade = 5,
  Reset = 6,
  Low = 7,
  High = 8,
  NewBestBid = 9,
  NewBestAsk = 10,
  Fill = 11
}