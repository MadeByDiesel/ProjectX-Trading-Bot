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
  private _posCache = new Map<string, { ts: number; net: number }>();
  private _posTtlMs = 3000; // cache position for 3 seconds to avoid 429s

  constructor(config: ProjectXConfig) {
    this.config = config;
    this.apiService = new ApiService(config.baseURL);
    this.signalRService = new SignalRService();
  }

  private async fetchAllAccountsMerged(): Promise<any[]> {
    await this.initialize();
    const live = await this.apiService.searchAccounts({ live: true }).catch(() => ({ accounts: [] }));
    const prac = await this.apiService.searchAccounts({ live: false }).catch(() => ({ accounts: [] }));

    // Do not strip fields — carry full objects forward
    const mergeById = new Map<number, any>();
    for (const a of (live.accounts ?? [])) mergeById.set(a.id, a);
    for (const a of (prac.accounts ?? [])) mergeById.set(a.id, a);

    return Array.from(mergeById.values());
  }

  private isTradableAccount(a: any): boolean {
    if (!a) return false;
    return a.canTrade === true;  // only trust the canonical flag
  }

  // Make sure we have a selected account and it’s tradable
  private async ensureActiveAccount(): Promise<void> {
    await this.initialize();
    if (this.selectedAccountId == null) {
      throw new Error('No account selected (selectedAccountId is null)');
    }

    const all = await this.fetchAllAccountsMerged();
    const acct = all.find(a => a.id === this.selectedAccountId);

    // Emit a precise verification log with all relevant flags
    console.info('[account:verify]', acct ? {
      id: acct.id,
      number: acct.accountNumber ?? acct.number ?? acct.name,
      canTrade: acct.canTrade,
      isVisible: acct.isVisible,
      simulated: acct.simulated,
      active: acct.active,
      isActive: acct.isActive,
      status: acct.status,
      live: acct.live,
      balance: acct.balance,
    } : { id: this.selectedAccountId, found: false });

    if (!acct) {
      throw new Error(`Selected account unknown (id=${this.selectedAccountId})`);
    }
    if (!this.isTradableAccount(acct)) {
      throw new Error(`Selected account (id=${acct.id}) is not tradable (canTrade=false)`);
    }
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

  // async createOrder(orderRequest: {
  //   contractId: string;
  //   type: number;
  //   side: number;
  //   size: number;
  //   limitPrice?: number;
  //   stopPrice?: number;
  //   trailPrice?: number;
  //   customTag?: string;
  //   linkedOrderId?: number;
  // }): Promise<number> {
  //   await this.initialize();
  //   if (!this.selectedAccountId) throw new Error('No account selected');
    
  //   const response = await this.apiService.placeOrder({
  //     accountId: this.selectedAccountId,
  //     ...orderRequest
  //   });
  //   if (!response.success) throw new Error(response.errorMessage);
  //   return response.orderId;
  // }

  async createOrder(orderRequest: {
    contractId: string;
    type: number;   // 1=Limit, 2=Market, 4=Stop, 5=TrailingStop, 6=JoinBid, 7=JoinAsk
    side: number;   // 0=Bid(Buy), 1=Ask(Sell)
    size: number;
    limitPrice?: number;
    stopPrice?: number;
    trailPrice?: number;
    linkedOrderId?: number;
  }): Promise<number> {
    await this.initialize();
    if (!this.selectedAccountId) throw new Error('No account selected');

    await this.ensureActiveAccount();

    // ✅ Strict side (only 0/1 accepted)
    const side = orderRequest.side === 0 ? 0 : 1;


    // ✅ For Market=2, do NOT send limit/stop/trail prices
    const payload: any = {
      accountId: this.selectedAccountId,
      contractId: orderRequest.contractId,
      type: 2,          // force Market
      side,
      size: orderRequest.size,
    };

    console.log('[order->broker]', payload);

    const response = await this.apiService.placeOrder(payload);
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

  async partialClosePosition(contractId: string, size: number): Promise<void> {
    await this.initialize();
    if (!this.selectedAccountId) throw new Error('No account selected');
    if (!Number.isFinite(size) || size <= 0) throw new Error('partialClosePosition: size must be > 0');

    const response = await this.apiService.partialClosePosition({
      accountId: this.selectedAccountId,
      contractId,
      size: Math.floor(size)
    });
    if (!response.success) throw new Error(response.errorMessage);
  }

  /**
   * Fetch the current OPEN net position size for a given contract.
   * Returns positive for long, negative for short, 0 if flat.
   * Uses a permissive 'any' read to accommodate Topstep schema variations.
   */
  async getNetPositionSize(contractId: string): Promise<number> {
    await this.initialize();
    if (!this.selectedAccountId) throw new Error('No account selected');

    const resp = await this.apiService.searchOpenPositions({ accountId: this.selectedAccountId });
    if (!resp.success) throw new Error(resp.errorMessage);

    const pos = resp.positions.find(p => (p as any).contractId === contractId) as any | undefined;
    if (!pos) return 0;

    // Tolerate different payload shapes
    const netQuantity   = (pos as any).netQuantity;
    const longQuantity  = (pos as any).longQuantity;
    const shortQuantity = (pos as any).shortQuantity;
    const quantity      = (pos as any).quantity;  

    let net: number | undefined =
      (typeof netQuantity === 'number') ? netQuantity : undefined;

    if (net === undefined) {
      const hasLS = (typeof longQuantity === 'number') || (typeof shortQuantity === 'number');
      if (hasLS) {
        net = (Number(longQuantity) || 0) - (Number(shortQuantity) || 0);
      }
    }

    if (net === undefined && typeof quantity === 'number') {
      net = quantity;
    }

    return Number(net ?? 0);
  }

  /**
   * Close EXACTLY 'requestedSize' (clamped to what is actually open).
   * Uses /api/Position/partialCloseContract under the hood.
   * Returns the qty closed and remaining absolute qty.
   */
  async closePositionByQtySafe(contractId: string, requestedSize: number): Promise<{ closed: number; remaining: number }> {
    await this.initialize();
    if (!this.selectedAccountId) throw new Error('No account selected');
    if (!Number.isFinite(requestedSize) || requestedSize <= 0) throw new Error('requestedSize must be > 0');

    const net = await this.getNetPositionSize(contractId);
    const netAbs = Math.abs(net);
    if (netAbs === 0) return { closed: 0, remaining: 0 };

    const size = Math.min(Math.floor(requestedSize), netAbs);
    if (size === 0) return { closed: 0, remaining: netAbs };

    const response = await this.apiService.partialClosePosition({
      accountId: this.selectedAccountId,
      contractId,
      size
    });
    if (!response.success) throw new Error(response.errorMessage);

    return { closed: size, remaining: netAbs - size };
  }

  /**
   * Close ALL currently open qty (without flattening), by quantity.
   * This does NOT call /closeContract; it uses partial close for the full size.
   */
  async closeAllQty(contractId: string): Promise<void> {
    const netAbs = Math.abs(await this.getNetPositionSize(contractId));
    if (netAbs > 0) {
      await this.closePositionByQtySafe(contractId, netAbs);
    }
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

  public setSelectedAccountId(id: number): void {
    this.selectedAccountId = id;
    console.log('[account:selected]', { id });
  }
}
