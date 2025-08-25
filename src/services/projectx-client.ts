import { ApiService } from './api.service';
import { SignalRService } from './signalr-service';
import { 
  ProjectXConfig, 
  MarketData, 
  Order, 
  Position, 
  Account, 
  BarData, 
  Contract, 
  Quote,
  GatewayQuote,
  GatewayUserOrder,
  GatewayUserPosition,
  GatewayUserTrade,
  GatewayUserAccount
} from '../types';

export class ProjectXClient {
  private apiService: ApiService;
  private signalRService: SignalRService;
  private config: ProjectXConfig;
  private isInitialized: boolean = false;
  private selectedAccountId: number | null = null;

  constructor(config: ProjectXConfig) {
    this.config = config;
    this.apiService = new ApiService(config.baseURL);
    this.signalRService = new SignalRService();
  }

  async initialize(): Promise<void> {
    if (!this.isInitialized) {
      // Use CORRECT authentication parameters
      await this.apiService.authenticate({
        userName: this.config.userName,
        apiKey: this.config.apiKey
      });
      
      // Get account ID for SignalR subscription
      const accountsResponse = await this.apiService.searchAccounts({ live: true });
      if (accountsResponse.accounts.length > 0) {
        this.selectedAccountId = accountsResponse.accounts[0].id;
      }
      
      this.isInitialized = true;
    }
  }

  // Account methods
  async getAccounts(): Promise<Account[]> {
    await this.initialize();
    const response = await this.apiService.searchAccounts({ live: true });
    return response.accounts;
  }

  async getAccount(accountId: string): Promise<Account> {
    await this.initialize();
    const response = await this.apiService.searchAccounts({ accountNumber: accountId, live: true });
    return response.accounts[0];
  }

  // Market Data methods
  async getMarketData(symbol: string): Promise<MarketData> {
    throw new Error('getMarketData not implemented - use SignalR for real-time data');
  }

  async searchContracts(symbol: string): Promise<Contract[]> {
    await this.initialize();
    const response = await this.apiService.searchContracts({ 
      searchText: symbol, 
      live: false  // ← Contract search requires live: false
    });
    return response.contracts;
  }

  async getQuotes(contractIds: string[]): Promise<Quote[]> {
    throw new Error('getQuotes not implemented - use SignalR for real-time quotes');
  }

  async getBars(contractId: string, timeframe: string, limit: number = 100): Promise<BarData[]> {
    await this.initialize();
    
    // Convert timeframe to unit and unitNumber
    const unit = 1; // Always minutes
    const unitNumber = parseInt(timeframe); // 15, 30, 60, etc.
    
    // Calculate default time range (last 24 hours)
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago

    const request = {
      contractId,
      live: false, // ← CRITICAL: Historical data requires live: false
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      unit: unit,
      unitNumber: unitNumber,
      limit: limit,
      includePartialBar: false
    };

    const response = await this.apiService.retrieveBars(request);
    return response.bars;
  }

  async getContract(contractId: string): Promise<Contract> {
    await this.initialize();
    return await this.apiService.searchContractById({ contractId });
  }

  // Order methods
  async getOrders(): Promise<Order[]> {
    await this.initialize();
    if (!this.selectedAccountId) throw new Error('No account selected');
    
    const response = await this.apiService.searchOrders({ 
      accountId: this.selectedAccountId 
    });
    if (!response.success) throw new Error(response.errorMessage);
    return response.orders;
  }

  async createOrder(orderRequest: {
    contractId: string;
    type: number;
    side: number;
    size: number;
    limitPrice?: number;
    stopPrice?: number;
    trailPrice?: number;
    customTag?: string;
    linkedOrderId?: number;
  }): Promise<number> {
    await this.initialize();
    if (!this.selectedAccountId) throw new Error('No account selected');
    
    const response = await this.apiService.placeOrder({
      accountId: this.selectedAccountId,
      ...orderRequest
    });
    if (!response.success) throw new Error(response.errorMessage);
    return response.orderId;
  }

  async cancelOrder(orderId: number): Promise<void> {
    await this.initialize();
    if (!this.selectedAccountId) throw new Error('No account selected');
    
    const response = await this.apiService.cancelOrder({
      accountId: this.selectedAccountId,
      orderId
    });
    if (!response.success) throw new Error(response.errorMessage);
  }

  // Position methods
  async getPositions(): Promise<Position[]> {
    await this.initialize();
    if (!this.selectedAccountId) throw new Error('No account selected');
    
    const response = await this.apiService.searchOpenPositions({ 
      accountId: this.selectedAccountId 
    });
    if (!response.success) throw new Error(response.errorMessage);
    return response.positions;
  }

  async closePosition(contractId: string): Promise<void> {
    await this.initialize();
    if (!this.selectedAccountId) throw new Error('No account selected');
    
    const response = await this.apiService.closePosition({
      accountId: this.selectedAccountId,
      contractId
    });
    if (!response.success) throw new Error(response.errorMessage);
  }

  // Utility methods
  async getBalance(): Promise<number> {
    const accounts = await this.getAccounts();
    return accounts[0]?.balance || 0;
  }

  async getEquity(): Promise<number> {
    const accounts = await this.getAccounts();
    return accounts[0]?.balance || 0;
  }

  // SignalR WebSocket methods
  async connectWebSocket(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const authToken = this.apiService.getAuthToken();
    if (!authToken || !this.selectedAccountId) {
      throw new Error('Not authenticated or account not selected');
    }

    await this.signalRService.initialize(authToken, this.selectedAccountId);
  }

  async subscribeToSymbols(symbols: string[]): Promise<void> {
    if (!this.signalRService.isConnected()) {
      throw new Error('SignalR service not connected. Call connectWebSocket() first.');
    }

    for (const symbol of symbols) {
      try {
        const contracts = await this.searchContracts(symbol);
        if (contracts.length > 0) {
          await this.signalRService.subscribeToMarketData(contracts[0].id);
        }
      } catch (error) {
        console.error(`Failed to subscribe to ${symbol}:`, error);
      }
    }
  }

  // Event handlers with SignalR types
  onMarketData(callback: (data: GatewayQuote & { contractId: string }) => void): void {
    this.signalRService.on('market_data', callback);
  }

  onOrderUpdate(callback: (order: GatewayUserOrder) => void): void {
    this.signalRService.on('order_update', callback);
  }

  onPositionUpdate(callback: (position: GatewayUserPosition) => void): void {
    this.signalRService.on('position_update', callback);
  }

  onTradeUpdate(callback: (trade: GatewayUserTrade) => void): void {
    this.signalRService.on('trade_update', callback);
  }

  onAccountUpdate(callback: (account: GatewayUserAccount) => void): void {
    this.signalRService.on('account_update', callback);
  }

  onConnected(callback: () => void): void {
    if (this.signalRService.isConnected()) {
      callback();
    }
  }

  onError(callback: (error: any) => void): void {
    console.warn('Custom error handling not implemented for SignalR');
  }

  async disconnectWebSocket(): Promise<void> {
    await this.signalRService.disconnect();
  }

  isWebSocketConnected(): boolean {
    return this.signalRService.isConnected();
  }

  getAuthToken(): string | null {
    return this.apiService.getAuthToken();
  }

  getSelectedAccountId(): number | null {
    return this.selectedAccountId;
  }

  getSignalRService(): SignalRService {
    return this.signalRService;
  }
}
