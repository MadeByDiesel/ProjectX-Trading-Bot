// src/strategies/mnq-delta-trend/trader.ts
import { ProjectXClient } from '../../services/projectx-client';
import { ApiClient } from '../../services/api-client';
import { MarketDataService } from '../../services/market-data.service';
import { MNQDeltaTrendCalculator } from './calculator';
import { StrategyConfig, PositionState, MarketState, BarData } from './types';
import { Logger } from '../../utils/logger';
import { GatewayQuote, OrderSide, OrderType, GatewayUserPosition } from '../../types';

export class MNQDeltaTrendTrader {
  private client: ProjectXClient;
  private marketDataService: MarketDataService;
  private calculator: MNQDeltaTrendCalculator;
  private config: StrategyConfig;
  private positionState: PositionState;
  private marketState: MarketState;
  private isTradingHours: boolean = false;
  private isWarmUpComplete: boolean = false;
  private logger: Logger;
  private mnqContractId: string | null = null;
  private apiClient: ApiClient;

  constructor(client: ProjectXClient, baseURL: string, config: StrategyConfig) {
    this.client = client;
    this.apiClient = new ApiClient(baseURL);
    this.marketDataService = new MarketDataService(client);
    this.config = config;
    this.calculator = new MNQDeltaTrendCalculator(config);
    this.logger = new Logger('MNQDeltaTrend');
    
    this.positionState = {
      isInPosition: false,
      entryPrice: 0,
      stopLoss: 0,
      takeProfit: 0,
      positionSize: 0,
      direction: 'none',
      entryTime: 0
    };

    this.marketState = {
      currentPrice: 0,
      atr: 0,
      higherTimeframeTrend: 'neutral',
      deltaCumulative: 0,
      previousBars: []
    };

    this.setupEventListeners();
  }

  async start(): Promise<void> {
    this.logger.info('Starting MNQ Delta Trend Strategy');
    
    // Initialize with warm-up data first
    await this.initializeWarmUpData();
    
    // Then connect to real-time data
    await this.client.connectWebSocket();
    await this.client.subscribeToSymbols([this.config.symbol]);
  }

  private async initializeWarmUpData(): Promise<void> {
    try {
      this.logger.info('Fetching historical data for strategy warm-up...');
      
      // Find all MNQ contracts
      const contracts = await this.client.searchContracts('MNQ');
      
      if (contracts.length === 0) {
        throw new Error('No MNQ contracts found');
      }

      // DEBUG: Log all MNQ contracts
      this.logger.info(`Found ${contracts.length} MNQ contracts:`);
      contracts.forEach((contract, index) => {
        this.logger.info(`  ${index + 1}. ${contract.name} - ${contract.description} (Active: ${contract.activeContract})`);
      });

      // Filter for active MNQ contracts and find the most current one
      const activeMNQContracts = contracts.filter(contract => 
        contract.activeContract && 
        (contract.symbolId.includes('MNQ') || contract.name.includes('MNQ'))
      );

      if (activeMNQContracts.length === 0) {
        throw new Error('No active MNQ contracts found');
      }

      // Sort by contract name to find the most recent
      const mostCurrentContract = activeMNQContracts.sort((a, b) => 
        b.name.localeCompare(a.name)
      )[0];

      this.mnqContractId = mostCurrentContract.id;
      this.logger.info(`✅ Selected most current MNQ contract: ${mostCurrentContract.name} - ${mostCurrentContract.description}`);

      // Fetch warm-up data
      const [data15min, data3min] = await Promise.all([
        this.marketDataService.fetchWarmUpData15min(this.mnqContractId, this.config),
        this.marketDataService.fetchWarmUpData3min(this.mnqContractId, this.config)
      ]);

      // Process warm-up data
      data15min.forEach(bar => this.calculator.processWarmUpBar(bar, '15min'));
      data3min.forEach(bar => this.calculator.processWarmUpBar(bar, '3min'));

      this.calculator.completeWarmUp();
      this.isWarmUpComplete = true;
      
      this.logger.info(`✅ Warm-up complete: ${data15min.length}15min bars, ${data3min.length}3min bars`);
      
    } catch (error) {
      this.logger.error('Warm-up initialization failed:', error);
      throw error;
    }
  }

  private setupEventListeners(): void {
    // Real-time market data from SignalR
    this.client.onMarketData((data: GatewayQuote & { contractId: string }) => {
      if (data.symbol === this.config.symbol) {
        this.handleRealTimeMarketData(data);
      }
    });

    this.client.onOrderUpdate((order) => {
      this.logger.info(`Order update: ${order.status}`);
    });

    this.client.onPositionUpdate((position: GatewayUserPosition) => {
      if (this.mnqContractId && position.contractId === this.mnqContractId) {
        this.handleNewPosition(position);
      }
    });

    this.client.onConnected(() => {
      this.logger.info('Real-time data connected - strategy ready');
    });
  }

  private async handleNewPosition(position: GatewayUserPosition): Promise<void> {
    try {
      this.logger.info(`New position update: ID ${position.id}, ${position.type === 1 ? 'Long' : 'Short'}, Size ${position.size}`);
      await this.notifyTradeOpened(position);
    } catch (error) {
      this.logger.error('Failed to handle new position event:', error);
    }
  }

  private async notifyTradeOpened(position: GatewayUserPosition): Promise<void> {
    try {
      const tradeData = {
        id: `pos-${position.id}`,
        entryTime: position.creationTimestamp,
        direction: position.type === 1 ? 'long' : 'short',
        entryPrice: position.averagePrice,
        exitPrice: null,
        pnl: null,
        reason: 'Strategy entry',
        status: 'open',
        contract: position.contractId,
        quantity: position.size
      };

      await this.apiClient.post('/api/trades', tradeData);
      this.logger.info(`Trade opened notification sent for position ${position.id}`);
    } catch (error) {
      this.logger.error('Failed to notify trade opening:', error);
    }
  }

  private async notifyTradeClosed(positionId: number, exitPrice: number, pnl: number, reason: string): Promise<void> {
    try {
      await this.apiClient.post(`/api/trades/pos-${positionId}`, {
        exitPrice,
        pnl,
        reason,
        status: 'closed'
      });
      this.logger.info(`Trade closed notification sent for position ${positionId}`);
    } catch (error) {
      this.logger.error('Failed to notify trade closing:', error);
    }
  }

  private handleRealTimeMarketData(data: GatewayQuote): void {
      // TEMPORARY DEBUG - Remove after testing
    console.log('MARKET DATA RECEIVED:', {
      symbol: data.symbol,
      price: data.lastPrice,
      change: data.change,
      time: new Date().toISOString()
    });

    if (!this.isWarmUpComplete) return;

    // DEBUG: Log incoming market data
    this.logger.debug(`Market data: ${data.symbol} @ ${data.lastPrice}, Δ: ${data.change}`);
    
    this.marketState.currentPrice = data.lastPrice;

    this.marketState.currentPrice = data.lastPrice;
    
    this.isTradingHours = this.marketDataService.isWithinTradingHours(
      this.config.tradingStartTime, 
      this.config.tradingEndTime
    );

    if (!this.isTradingHours) {
      if (this.positionState.isInPosition) {
        this.closePosition('Outside trading hours');
      }
      return;
    }

    const currentBar = this.createBarFromRealTimeData(data);
    this.processNewBar(currentBar);
  }

  private createBarFromRealTimeData(quote: GatewayQuote): BarData {
    return {
      timestamp: new Date().toISOString(),
      open: quote.lastPrice,
      high: quote.lastPrice,
      low: quote.lastPrice,
      close: quote.lastPrice,
      volume: quote.volume,
      delta: quote.change
    };
  }

  private async processNewBar(bar: BarData): Promise<void> {
    try {
          // DEBUG: Log new bar creation
      this.logger.debug(`New bar: ${bar.timestamp} O:${bar.open} H:${bar.high} L:${bar.low} C:${bar.close}`);

      const { signal, reason } = this.calculator.processNewBar(bar, this.marketState);
       // DEBUG: Log the signal
      this.logger.debug(`Signal: ${signal}, Reason: ${reason}`);
      
      this.logger.debug(`Signal: ${signal}, Reason: ${reason}`);

      if (signal !== 'hold' && !this.positionState.isInPosition) {
        const direction = signal === 'buy' ? 'long' : 'short';
        await this.executeTrade(direction, bar);
      }

      if (this.positionState.isInPosition) {
        this.checkExitConditions(bar);
      }

    } catch (error) {
      this.logger.error('Error processing bar:', error);
    }
  }

  private async executeTrade(direction: 'long' | 'short', bar: BarData): Promise<void> {
    try {
      if (!this.mnqContractId) {
        throw new Error('MNQ contract ID not available');
      }

      const balance = await this.client.getBalance();
      const positionSize = this.calculator.calculatePositionSize(
        bar.close,
        this.marketState.atr,
        balance
      );

      if (positionSize <= 0) return;

      const { stopLoss, takeProfit } = this.calculator.calculateStopLossTakeProfit(
        bar.close,
        direction,
        this.marketState.atr
      );

      const side = direction === 'long' ? OrderSide.Bid : OrderSide.Ask;
      const type = OrderType.Market;
      
      const orderId = await this.client.createOrder({
        contractId: this.mnqContractId,
        type: type,
        side: side,
        size: positionSize
      });

      this.positionState = {
        isInPosition: true,
        entryPrice: bar.close,
        stopLoss,
        takeProfit,
        positionSize,
        direction,
        entryTime: Date.now()
      };

      this.logger.info(`Entered ${direction} position at ${bar.close}, Order ID: ${orderId}`);

    } catch (error) {
      this.logger.error('Failed to execute trade:', error);
    }
  }

  private async checkExitConditions(bar: BarData): Promise<void> {
    const { direction, stopLoss, takeProfit } = this.positionState;

    if ((direction === 'long' && bar.close <= stopLoss) ||
        (direction === 'short' && bar.close >= stopLoss)) {
      await this.closePosition('Stop loss hit');
    } else if ((direction === 'long' && bar.close >= takeProfit) ||
               (direction === 'short' && bar.close <= takeProfit)) {
      await this.closePosition('Take profit hit');
    }
  }

  private async closePosition(reason: string): Promise<void> {
    try {
      if (!this.mnqContractId) {
        throw new Error('MNQ contract ID not available');
      }

      const exitPrice = this.marketState.currentPrice;
      
      await this.client.closePosition(this.mnqContractId);
      this.logger.info(`Closed position: ${reason}`);

      const pnl = this.calculatePnL(
        this.positionState.entryPrice,
        exitPrice,
        this.positionState.positionSize,
        this.positionState.direction as 'long' | 'short'
      );

      await this.notifyTradeClosed(
        this.positionState.entryTime,
        exitPrice,
        pnl,
        reason
      );

      this.positionState.isInPosition = false;
      this.positionState.direction = 'none';

    } catch (error) {
      this.logger.error('Failed to close position:', error);
    }
  }

  private calculatePnL(entryPrice: number, exitPrice: number, size: number, direction: 'long' | 'short'): number {
    const priceDifference = exitPrice - entryPrice;
    const pnl = direction === 'long' ? priceDifference * size : -priceDifference * size;
    return Number(pnl.toFixed(2));
  }

  stop(): void {
    this.client.disconnectWebSocket();
    this.logger.info('Strategy stopped');
  }

  getWarmUpStatus(): boolean {
    return this.isWarmUpComplete;
  }

  getContractId(): string | null {
    return this.mnqContractId;
  }
}

// import { ProjectXClient } from '../../services/projectx-client';
// import { MarketDataService } from '../../services/market-data.service';
// import { MNQDeltaTrendCalculator } from './calculator';
// import { StrategyConfig, PositionState, MarketState, BarData } from './types';
// import { Logger } from '../../utils/logger';
// import { GatewayQuote, OrderSide, OrderType } from '../../types';

// export class MNQDeltaTrendTrader {
//   private client: ProjectXClient;
//   private marketDataService: MarketDataService;
//   private calculator: MNQDeltaTrendCalculator;
//   private config: StrategyConfig;
//   private positionState: PositionState;
//   private marketState: MarketState;
//   private isTradingHours: boolean = false;
//   private isWarmUpComplete: boolean = false;
//   private logger: Logger;
//   private mnqContractId: string | null = null;

//   constructor(client: ProjectXClient, config: StrategyConfig) {
//     this.client = client;
//     this.marketDataService = new MarketDataService(client); // ← Pass client to MarketDataService
//     this.config = config;
//     this.calculator = new MNQDeltaTrendCalculator(config);
//     this.logger = new Logger('MNQDeltaTrend');
    
//     this.positionState = {
//       isInPosition: false,
//       entryPrice: 0,
//       stopLoss: 0,
//       takeProfit: 0,
//       positionSize: 0,
//       direction: 'none',
//       entryTime: 0
//     };

//     this.marketState = {
//       currentPrice: 0,
//       atr: 0,
//       higherTimeframeTrend: 'neutral',
//       deltaCumulative: 0,
//       previousBars: []
//     };

//     this.setupEventListeners();
//   }

//   async start(): Promise<void> {
//     this.logger.info('Starting MNQ Delta Trend Strategy');
    
//     // Initialize with warm-up data first
//     await this.initializeWarmUpData();
    
//     // Then connect to real-time data
//     await this.client.connectWebSocket();
//     await this.client.subscribeToSymbols([this.config.symbol]);
//   }

//   private async initializeWarmUpData(): Promise<void> {
//     try {
//       this.logger.info('Fetching historical data for strategy warm-up...');
      
//       // Find all MNQ contracts
//       const contracts = await this.client.searchContracts('MNQ');
      
//       if (contracts.length === 0) {
//         throw new Error('No MNQ contracts found');
//       }

//       // DEBUG: Log all MNQ contracts
//       this.logger.info(`Found ${contracts.length} MNQ contracts:`);
//       contracts.forEach((contract, index) => {
//         this.logger.info(`  ${index + 1}. ${contract.name} - ${contract.description} (Active: ${contract.activeContract})`);
//       });

//       // Filter for active MNQ contracts and find the most current one
//       const activeMNQContracts = contracts.filter(contract => 
//         contract.activeContract && 
//         (contract.symbolId.includes('MNQ') || contract.name.includes('MNQ'))
//       );

//       if (activeMNQContracts.length === 0) {
//         throw new Error('No active MNQ contracts found');
//       }

//       // Sort by contract name to find the most recent
//       const mostCurrentContract = activeMNQContracts.sort((a, b) => 
//         b.name.localeCompare(a.name)
//       )[0];

//       this.mnqContractId = mostCurrentContract.id;
//       this.logger.info(`✅ Selected most current MNQ contract: ${mostCurrentContract.name} - ${mostCurrentContract.description}`);

//       // Fetch warm-up data
//       const [data15min, data3min] = await Promise.all([
//         this.marketDataService.fetchWarmUpData15min(this.mnqContractId, this.config),
//         this.marketDataService.fetchWarmUpData3min(this.mnqContractId, this.config)
//       ]);

//       // Process warm-up data
//       data15min.forEach(bar => this.calculator.processWarmUpBar(bar, '15min'));
//       data3min.forEach(bar => this.calculator.processWarmUpBar(bar, '3min'));

//       this.calculator.completeWarmUp();
//       this.isWarmUpComplete = true;
      
//       this.logger.info(`✅ Warm-up complete: ${data15min.length}15min bars, ${data3min.length}3min bars`);
      
//     } catch (error) {
//       this.logger.error('Warm-up initialization failed:', error);
//       throw error;
//     }
//   }

//   private setupEventListeners(): void {
//     // Real-time market data from SignalR
//     this.client.onMarketData((data: GatewayQuote & { contractId: string }) => {
//       if (data.symbol === this.config.symbol) {
//         this.handleRealTimeMarketData(data);
//       }
//     });

//     this.client.onOrderUpdate((order) => {
//       this.logger.info(`Order update: ${order.status}`);
//     });

//     this.client.onConnected(() => {
//       this.logger.info('Real-time data connected - strategy ready');
//     });
//   }

//   private handleRealTimeMarketData(data: GatewayQuote): void {
//     // Skip processing if warm-up not complete
//     if (!this.isWarmUpComplete) return;

//     this.marketState.currentPrice = data.lastPrice;
    
//     // Check trading hours using TimeUtils
//     this.isTradingHours = this.marketDataService.isWithinTradingHours(
//       this.config.tradingStartTime, 
//       this.config.tradingEndTime
//     );

//     if (!this.isTradingHours) {
//       if (this.positionState.isInPosition) {
//         this.closePosition('Outside trading hours');
//       }
//       return;
//     }

//     // Create bar from real-time data
//     const currentBar = this.createBarFromRealTimeData(data);
//     this.processNewBar(currentBar);
//   }

//   private createBarFromRealTimeData(quote: GatewayQuote): BarData {
//     return {
//       timestamp: new Date().toISOString(), // ISO string to match API type
//       open: quote.lastPrice,
//       high: quote.lastPrice,
//       low: quote.lastPrice,
//       close: quote.lastPrice,
//       volume: quote.volume,
//       delta: quote.change
//     };
//   }

//   private async processNewBar(bar: BarData): Promise<void> {
//     try {
//       const { signal, reason } = this.calculator.processNewBar(bar, this.marketState);
      
//       this.logger.debug(`Signal: ${signal}, Reason: ${reason}`);

//       if (signal !== 'hold' && !this.positionState.isInPosition) {
//         const direction = signal === 'buy' ? 'long' : 'short';
//         await this.executeTrade(direction, bar);
//       }

//       if (this.positionState.isInPosition) {
//         this.checkExitConditions(bar);
//       }

//     } catch (error) {
//       this.logger.error('Error processing bar:', error);
//     }
//   }

//   private async executeTrade(direction: 'long' | 'short', bar: BarData): Promise<void> {
//     try {
//       if (!this.mnqContractId) {
//         throw new Error('MNQ contract ID not available');
//       }

//       const balance = await this.client.getBalance();
//       const positionSize = this.calculator.calculatePositionSize(
//         bar.close,
//         this.marketState.atr,
//         balance
//       );

//       if (positionSize <= 0) return;

//       const { stopLoss, takeProfit } = this.calculator.calculateStopLossTakeProfit(
//         bar.close,
//         direction,
//         this.marketState.atr
//       );

//       const side = direction === 'long' ? OrderSide.Bid : OrderSide.Ask;
//       const type = OrderType.Market;
      
//       const orderId = await this.client.createOrder({
//         contractId: this.mnqContractId,
//         type: type,
//         side: side,
//         size: positionSize
//       });

//       // NOTIFY TRADE OPENED - using your actual variables
//       await this.notifyTradeOpened({
//         direction,
//         entryPrice: bar.close, // Your actual entry price
//         contractId: this.mnqContractId,
//         quantity: positionSize, // Your actual position size
//         reason: `Delta surge with ${this.marketState.higherTimeframeTrend} trend`
//       });

//       this.positionState = {
//         isInPosition: true,
//         entryPrice: bar.close,
//         stopLoss,
//         takeProfit,
//         positionSize,
//         direction,
//         entryTime: Date.now()
//       };

//       this.logger.info(`Entered ${direction} position at ${bar.close}, Order ID: ${orderId}`);

//     } catch (error) {
//       this.logger.error('Failed to execute trade:', error);
//     }
//   }

//   private async notifyTradeOpened(position: {
//     id: number;
//     accountId: number;
//     contractId: string;
//     creationTimestamp: string;
//     type: number;
//     size: number;
//     averagePrice: number;
//   }): Promise<void> {
//     try {
//       // Convert position to trade format for your monitor
//       const tradeData = {
//         id: `pos-${position.id}`,
//         entryTime: position.creationTimestamp,
//         direction: position.type === 1 ? 'long' : 'short', // Assuming 1=long, 2=short
//         entryPrice: position.averagePrice,
//         exitPrice: null,
//         pnl: null,
//         reason: 'Strategy entry',
//         status: 'open',
//         contract: position.contractId,
//         quantity: position.size
//       };

//       // Store trade in your API (if you want to maintain trade history)
//       await this.client.apiService.post('/trades', tradeData);
//     } catch (error) {
//       this.logger.error('Failed to notify trade opening:', error);
//     }
//   }

//   private async checkExitConditions(bar: BarData): Promise<void> {
//     const { direction, stopLoss, takeProfit } = this.positionState;

//     if ((direction === 'long' && bar.close <= stopLoss) ||
//         (direction === 'short' && bar.close >= stopLoss)) {
//       await this.closePosition('Stop loss hit');
//     } else if ((direction === 'long' && bar.close >= takeProfit) ||
//                (direction === 'short' && bar.close <= takeProfit)) {
//       await this.closePosition('Take profit hit');
//     }
//   }

//   private async closePosition(reason: string): Promise<void> {
//     try {
//       if (!this.mnqContractId) {
//         throw new Error('MNQ contract ID not available');
//       }

//       const positions = await this.client.getPositions();
//       const mnqPosition = positions.find(p => p.contractId === this.mnqContractId);

//       if (mnqPosition) {
//         // Get current price from market state or position
//         const exitPrice = this.marketState.currentPrice || mnqPosition.currentPrice;
        
//         await this.client.closePosition(mnqPosition.contractId);
//         this.logger.info(`Closed position: ${reason}`);

//         // Calculate PnL based on your position state
//         const pnl = this.calculator.calculatePnL(
//           this.positionState.entryPrice,
//           exitPrice,
//           this.positionState.positionSize,
//           this.positionState.direction
//         );

//         // NOTIFY TRADE CLOSED - using your actual variables
//         await this.notifyTradeClosed('trade-id-placeholder', {
//           exitPrice,
//           pnl,
//           reason
//         });
//       }

//       this.positionState.isInPosition = false;
//       this.positionState.direction = 'none';

//     } catch (error) {
//       this.logger.error('Failed to close position:', error);
//     }
//   }

//   private async notifyTradeClosed(positionId: number, exitPrice: number, pnl: number, reason: string): Promise<void> {
//     try {
//       // Update the trade in your API
//       await this.client.apiService.put(`/trades/pos-${positionId}`, {
//         exitPrice,
//         pnl,
//         reason,
//         status: 'closed'
//       });
//     } catch (error) {
//       this.logger.error('Failed to notify trade closing:', error);
//     }
//   }



//   stop(): void {
//     this.client.disconnectWebSocket();
//     this.logger.info('Strategy stopped');
//   }

//   getWarmUpStatus(): boolean {
//     return this.isWarmUpComplete;
//   }

//   getContractId(): string | null {
//     return this.mnqContractId;
//   }
// }

