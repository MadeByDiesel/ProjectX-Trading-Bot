// src/services/signalr-service.ts
import * as signalR from '@microsoft/signalr';
import { Logger } from '../utils/logger';
import {
  GatewayUserAccount,
  GatewayUserOrder,
  GatewayUserPosition,
  GatewayUserTrade,
  GatewayQuote,
  GatewayTrade,
  GatewayDepth
} from '../types';

export class SignalRService {
  private userHubConnection: signalR.HubConnection | null = null;
  private marketHubConnection: signalR.HubConnection | null = null;
  private jwtToken: string | null = null;
  private selectedAccountId: number | null = null;
  private logger: Logger;
  private eventCallbacks: Map<string, Function[]> = new Map();
  private firstQuoteLogged = false;
  private subscribedContracts = new Set<string>();

  constructor() {
    this.logger = new Logger('SignalRService');
  }

  async initialize(jwtToken: string, selectedAccountId: number): Promise<void> {
    this.jwtToken = jwtToken;
    this.selectedAccountId = selectedAccountId;

    await this.initializeUserHub();
    await this.initializeMarketHub();
  }

  // ========== User Hub ==========
  private async initializeUserHub(): Promise<void> {
    if (!this.jwtToken || !this.selectedAccountId) {
      throw new Error('JWT token or account ID not set');
    }

    const userHubUrl = `https://rtc.topstepx.com/hubs/user?access_token=${this.jwtToken}`;

    this.userHubConnection = new signalR.HubConnectionBuilder()
      .withUrl(userHubUrl, {
        skipNegotiation: true,
        transport: signalR.HttpTransportType.WebSockets,
        accessTokenFactory: () => this.jwtToken!,
        timeout: 10000
      })
      .withAutomaticReconnect()
      .build();

    this.setupUserHubHandlers();

    try {
      await this.userHubConnection.start();
      this.logger.info('User Hub connected successfully');
      await this.subscribeToUserHub();
    } catch (error) {
      this.logger.error('Failed to start User Hub connection:', error);
      throw error;
    }
  }

  private setupUserHubHandlers(): void {
    const conn = this.userHubConnection;
    if (!conn) return;

    conn.on('GatewayUserAccount', (data: GatewayUserAccount) => {
      this.emit('account_update', data);
    });

    conn.on('GatewayUserOrder', (data: GatewayUserOrder) => {
      this.emit('order_update', data);
    });

    conn.on('GatewayUserPosition', (data: GatewayUserPosition) => {
      this.emit('position_update', data);
    });

    conn.on('GatewayUserTrade', (data: GatewayUserTrade) => {
      this.emit('trade_update', data);
    });

    conn.onreconnected(() => {
      this.logger.info('User Hub reconnected');
      this.subscribeToUserHub().catch((err) =>
        this.logger.error('Failed to re-subscribe User Hub after reconnect:', err)
      );
    });
  }

  private async subscribeToUserHub(): Promise<void> {
    if (!this.userHubConnection || !this.selectedAccountId) return;

    try {
      await this.userHubConnection.invoke('SubscribeAccounts');
      await this.userHubConnection.invoke('SubscribeOrders', this.selectedAccountId);
      await this.userHubConnection.invoke('SubscribePositions', this.selectedAccountId);
      await this.userHubConnection.invoke('SubscribeTrades', this.selectedAccountId);
      this.logger.info('Subscribed to User Hub events');
    } catch (error) {
      this.logger.error('Failed to subscribe to User Hub:', error);
    }
  }

  // ========== Market Hub ==========
  private async initializeMarketHub(): Promise<void> {
    if (!this.jwtToken) {
      throw new Error('JWT token not set');
    }

    const marketHubUrl = `https://rtc.topstepx.com/hubs/market?access_token=${this.jwtToken}`;

    this.marketHubConnection = new signalR.HubConnectionBuilder()
      .withUrl(marketHubUrl, {
        skipNegotiation: true,
        transport: signalR.HttpTransportType.WebSockets,
        accessTokenFactory: () => this.jwtToken!,
        timeout: 10000
      })
      .withAutomaticReconnect()
      .build();

    this.setupMarketHubHandlers();

    try {
      await this.marketHubConnection.start();
      this.logger.info('Market Hub connected successfully');
    } catch (error) {
      this.logger.error('Failed to start Market Hub connection:', error);
      throw error;
    }
  }

  private setupMarketHubHandlers(): void {
    const conn = this.marketHubConnection;
    if (!conn) {
      this.logger.warn('Market Hub connection not available when setting handlers');
      return;
    }

    conn.on('GatewayQuote', (contractId: string, data: GatewayQuote) => {
      if (!this.firstQuoteLogged) {
        this.logger.info(
          `First GatewayQuote: contractId=${contractId}, symbol=${(data as any).symbol ?? 'N/A'}, lastPrice=${data.lastPrice}`
        );
        this.firstQuoteLogged = true;
      }
      this.emit('market_data', { contractId, ...data });
    });

    conn.on('GatewayTrade', (contractId: string, data: GatewayTrade) => {
      this.emit('market_trade', { contractId, ...data });
    });

    conn.on('GatewayDepth', (contractId: string, data: GatewayDepth) => {
      this.emit('market_depth', { contractId, ...data });
    });

    conn.onreconnected(async () => {
      this.logger.info('Market Hub reconnected — re-subscribing existing contracts');
      await this.resubscribeAllContracts();
    });
  }

  // ========== Subscriptions ==========
  /**
   * Batch subscribe to quotes + trades for multiple contracts.
   * Tracks subscriptions for reconnect.
   */
  async subscribeToContracts(contractIds: string[]): Promise<void> {
    const conn = this.marketHubConnection;
    if (!conn || contractIds.length === 0) return;

    for (const id of contractIds) {
      try {
        await conn.invoke('SubscribeContractQuotes', id);
        await conn.invoke('SubscribeContractTrades', id);
        this.subscribedContracts.add(id);
        this.logger.info(`Subscribed to market data for contract: ${id}`);
      } catch (error) {
        this.logger.error(`Failed to subscribe to market data for ${id}:`, error);
      }
    }
  }

  /**
   * Backward-compatible single-contract subscribe. (Used by projectx-client)
   */
  async subscribeToMarketData(contractId: string): Promise<void> {
    return this.subscribeToContracts([contractId]);
  }

  async unsubscribeFromMarketData(contractId: string): Promise<void> {
    const conn = this.marketHubConnection;
    if (!conn) return;

    try {
      await conn.invoke('UnsubscribeContractQuotes', contractId);
      await conn.invoke('UnsubscribeContractTrades', contractId);
      this.subscribedContracts.delete(contractId);
      this.logger.info(`Unsubscribed from market data for contract: ${contractId}`);
    } catch (error) {
      this.logger.error('Failed to unsubscribe from market data:', error);
    }
  }

  private async resubscribeAllContracts(): Promise<void> {
    const conn = this.marketHubConnection;
    if (!conn || this.subscribedContracts.size === 0) return;

    for (const id of this.subscribedContracts) {
      try {
        await conn.invoke('SubscribeContractQuotes', id);
        await conn.invoke('SubscribeContractTrades', id);
        this.logger.info(`Re-subscribed contract after reconnect: ${id}`);
      } catch (err) {
        this.logger.error(`Failed to re-subscribe contract ${id} after reconnect`, err);
      }
    }
  }

  // ========== Events ==========
  on(event: string, callback: Function): void {
    if (!this.eventCallbacks.has(event)) {
      this.eventCallbacks.set(event, []);
    }
    this.eventCallbacks.get(event)!.push(callback);
  }

  private emit(event: string, data: any): void {
    const callbacks = this.eventCallbacks.get(event) || [];
    callbacks.forEach((callback) => {
      try {
        callback(data);
      } catch (err) {
        this.logger.error(`Error in '${event}' callback:`, err);
      }
    });
  }

  // ========== Lifecycle ==========
  async disconnect(): Promise<void> {
    if (this.userHubConnection) {
      await this.userHubConnection.stop();
    }
    if (this.marketHubConnection) {
      await this.marketHubConnection.stop();
    }
    this.logger.info('SignalR connections disconnected');
  }

  isConnected(): boolean {
    return (
      this.userHubConnection?.state === signalR.HubConnectionState.Connected &&
      this.marketHubConnection?.state === signalR.HubConnectionState.Connected
    );
  }
}
