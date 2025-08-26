// src/strategies/mnq-delta-trend/trader.ts

import { ProjectXClient } from '../../services/projectx-client';
import { ApiClient } from '../../services/api-client';
import { MarketDataService } from '../../services/market-data.service';
import { MNQDeltaTrendCalculator } from './calculator';
import { StrategyConfig, PositionState, MarketState, BarData } from './types';
import { Logger } from '../../utils/logger';
import {
  GatewayQuote,
  OrderSide,
  OrderType,
  GatewayUserPosition
} from '../../types';

export class MNQDeltaTrendTrader {
  private client: ProjectXClient;
  private marketDataService: MarketDataService;
  private calculator: MNQDeltaTrendCalculator;
  private config: StrategyConfig;
  private positionState: PositionState;
  private marketState: MarketState;
  private isTradingHours = false;
  private isWarmUpComplete = false;
  private logger: Logger;
  private mnqContractId: string | null = null;
  private apiClient: ApiClient;

  // --- de-dupe guard for repeated market data frames ---
  private lastTickSig: string | null = null;
  private lastTickAt: number = 0;
  private static readonly DEDUPE_MS = 300; // ignore identical frames within this window

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

  // relaxed match helper for either symbol or contractId
  private matchesSymbolOrContract(q: { symbol?: string; contractId?: string }): boolean {
    const feedSym = q.symbol ?? '';
    const want = this.config.symbol;
    const symOk = feedSym === want || feedSym.endsWith(want);
    const cidOk = this.mnqContractId ? q.contractId === this.mnqContractId : false;
    return symOk || cidOk;
  }

  async start(): Promise<void> {
    this.logger.info('Starting MNQ Delta Trend Strategy');

    // 1) Warm-up using historical bars
    await this.initializeWarmUpData();

    // 2) Connect realtime + subscribe (by SYMBOL — matches ProjectXClient API)
    await this.client.connectWebSocket();
    await this.client.subscribeToSymbols([this.config.symbol]);
  }

  private async initializeWarmUpData(): Promise<void> {
    try {
      this.logger.info('Fetching historical data for strategy warm-up...');

      // Search MNQ contracts
      const contracts = await this.client.searchContracts('MNQ');
      if (contracts.length === 0) {
        throw new Error('No MNQ contracts found');
      }

      this.logger.info(`Found ${contracts.length} MNQ contracts:`);
      contracts.forEach((c, i) => {
        this.logger.info(
          `  ${i + 1}. ${c.name} - ${c.description} (Active: ${c.activeContract})`
        );
      });

      // Pick most current active MNQ
      const activeMNQ = contracts.filter(
        (c) => c.activeContract && (c.symbolId.includes('MNQ') || c.name.includes('MNQ'))
      );
      if (activeMNQ.length === 0) {
        throw new Error('No active MNQ contracts found');
      }

      const mostCurrent = activeMNQ.sort((a, b) => b.name.localeCompare(a.name))[0];
      this.mnqContractId = mostCurrent.id;
      this.logger.info(`✅ Selected most current MNQ contract: ${mostCurrent.name} - ${mostCurrent.description}`);

      // // Pull warm-up bars
      // const [bars15, bars3] = await Promise.all([
      //   this.marketDataService.fetchWarmUpData15min(this.mnqContractId, this.config),
      //   this.marketDataService.fetchWarmUpData3min(this.mnqContractId, this.config)
      // ]);
      // Pull warm-up bars
      const warmupCfg = this.buildWarmupConfig();
      const [bars15, bars3] = await Promise.all([
        this.marketDataService.fetchWarmUpData15min(this.mnqContractId, warmupCfg),
        this.marketDataService.fetchWarmUpData3min(this.mnqContractId, warmupCfg)
      ]);

      bars15.forEach((bar) => this.calculator.processWarmUpBar(bar, '15min'));
      bars3.forEach((bar) => this.calculator.processWarmUpBar(bar, '3min'));

      this.calculator.completeWarmUp();
      this.isWarmUpComplete = true;

      this.logger.info(`✅ Warm-up complete: ${bars15.length}15min bars, ${bars3.length}3min bars`);
    } catch (err) {
      this.logger.error('Warm-up initialization failed:', err);
      throw err;
    }
  }

  private setupEventListeners(): void {
    // Real-time market data (quotes)
    this.client.onMarketData((raw: GatewayQuote & { contractId?: string; timestamp?: string | number }) => {
      const data = raw as GatewayQuote & { contractId?: string; timestamp?: string | number };

      // gate by symbol or contract
      if (!this.matchesSymbolOrContract({ symbol: (data as any).symbol, contractId: data.contractId as any })) return;

      // normalize lastPrice if missing
      if (typeof data.lastPrice !== 'number' || Number.isNaN(data.lastPrice)) {
        const p = (data as any).tradePrice ?? (data as any).close ?? (data as any).mark;
        const bid = (data as any).bid;
        const ask = (data as any).ask;
        const mid = (typeof bid === 'number' && typeof ask === 'number') ? (bid + ask) / 2 : undefined;
        if (typeof p === 'number') (data as any).lastPrice = p;
        else if (typeof mid === 'number') (data as any).lastPrice = mid;
      }

      // throttle "incomplete" spam logs
      if (typeof data.lastPrice !== 'number' || Number.isNaN(data.lastPrice)) {
        const now = Date.now();
        if (now - this.lastTickAt > 1000) {
          this.logger.debug(`Skipping incomplete quote for ${(data as any).symbol ?? 'N/A'}`);
          this.lastTickAt = now;
        }
        return;
      }

      // de-dupe identical frames in a short window
      const ts = typeof data.timestamp === 'number'
        ? data.timestamp
        : (data.timestamp ? Date.parse(data.timestamp as string) : Date.now());

      const deltaVal = (data as any).change ?? (data as any).delta ?? 'NA';
      const sig = `${data.contractId ?? ''}|${(data as any).symbol ?? ''}|${data.lastPrice}|${deltaVal}|${Math.floor(ts / 1000)}`;

      const nowMs = Date.now();
      if (this.lastTickSig === sig && (nowMs - this.lastTickAt) < MNQDeltaTrendTrader.DEDUPE_MS) {
        return; // drop duplicate tick
      }
      this.lastTickSig = sig;
      this.lastTickAt = nowMs;

      // proceed to strategy pipeline
      this.processQuote(data as GatewayQuote & { contractId: string });
    });

    // User order/position updates
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

  private processQuote(data: GatewayQuote & { contractId: string }): void {
    // Single, consistent debug line
    this.logger.debug(
      `Tick ${(data as any).symbol ?? 'N/A'} @ ${data.lastPrice} Δ:${(data as any).change ?? 'n/a'}`
    );

    if (!this.isWarmUpComplete) {
      this.logger.debug('Signal: hold, Reason: Warm-up in progress');
      return;
    }

    // Update market state
    this.marketState.currentPrice = data.lastPrice;

    // Respect trading window
    this.isTradingHours = this.marketDataService.isWithinTradingHours(
      this.config.tradingStartTime,
      this.config.tradingEndTime
    );
    if (!this.isTradingHours) {
      if (this.positionState.isInPosition) {
        // flatten if outside trading hours
        this.closePosition('Outside trading hours').catch((err) =>
          this.logger.error('Close position error (outside hours):', err)
        );
      }
      return;
    }

    // Build a 1-tick bar and process
    const bar = this.createBarFromQuote(data);
    this.processNewBar(bar).catch((err) =>
      this.logger.error('Error processing new bar:', err)
    );
  }

  private createBarFromQuote(quote: GatewayQuote): BarData {
    return {
      timestamp: new Date().toISOString(),
      open: quote.lastPrice,
      high: quote.lastPrice,
      low: quote.lastPrice,
      close: quote.lastPrice,
      volume: typeof (quote as any).volume === 'number' ? (quote as any).volume : 0,
      delta: typeof (quote as any).change === 'number' ? (quote as any).change : 0
    };
  }


  private buildWarmupConfig() {
    return {
      atrPeriod: 14,                                         // standard ATR lookback (leave as-is unless you want to tune)
      deltaSmaPeriod: this.config.deltaSMALength,            // from StrategyConfig
      breakoutLookback: this.config.breakoutLookbackBars,    // from StrategyConfig
      higherTimeframeWindow: 5,                              // matches our HTF window usage
      tradingStartTime: this.config.tradingStartTime,        // REQUIRED by WarmupConfig
      tradingEndTime: this.config.tradingEndTime             // REQUIRED by WarmupConfig
    };
  }


  private async processNewBar(bar: BarData): Promise<void> {
    // Trace newly constructed bar once (no duplicates)
    this.logger.debug(
      `New bar: ${bar.timestamp} O:${bar.open} H:${bar.high} L:${bar.low} C:${bar.close}`
    );

    const { signal, reason } = this.calculator.processNewBar(bar, this.marketState);
    this.logger.debug(`Signal: ${signal}, Reason: ${reason}`);

    if (signal !== 'hold' && !this.positionState.isInPosition) {
      const direction = signal === 'buy' ? 'long' : 'short';
      await this.executeTrade(direction, bar);
    }

    if (this.positionState.isInPosition) {
      this.checkExitConditions(bar).catch((err) =>
        this.logger.error('Exit condition check failed:', err)
      );
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
        type,
        side,
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

      // notify calculator about new position for trailing logic
      this.calculator.setPosition(bar.close, direction);

      this.logger.info(`Entered ${direction} position at ${bar.close}, Order ID: ${orderId}`);
    } catch (err) {
      this.logger.error('Failed to execute trade:', err);
    }
  }

  private async checkExitConditions(bar: BarData): Promise<void> {
    const { direction, stopLoss, takeProfit } = this.positionState;

    if (
      (direction === 'long' && bar.close <= stopLoss) ||
      (direction === 'short' && bar.close >= stopLoss)
    ) {
      await this.closePosition('Stop loss hit');
      return;
    }

    if (
      (direction === 'long' && bar.close >= takeProfit) ||
      (direction === 'short' && bar.close <= takeProfit)
    ) {
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

      await this.notifyTradeClosed(this.positionState.entryTime, exitPrice, pnl, reason);

      this.positionState.isInPosition = false;
      this.positionState.direction = 'none';

      // reset calculator position state
      this.calculator.clearPosition();
    } catch (err) {
      this.logger.error('Failed to close position:', err);
    }
  }

  private calculatePnL(
    entryPrice: number,
    exitPrice: number,
    size: number,
    direction: 'long' | 'short'
  ): number {
    const diff = exitPrice - entryPrice;
    const pnl = direction === 'long' ? diff * size : -diff * size;
    return Number(pnl.toFixed(2));
  }

  private async handleNewPosition(position: GatewayUserPosition): Promise<void> {
    try {
      this.logger.info(
        `New position update: ID ${position.id}, ${position.type === 1 ? 'Long' : 'Short'}, Size ${position.size}`
      );
      await this.notifyTradeOpened(position);
    } catch (err) {
      this.logger.error('Failed to handle new position event:', err);
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
    } catch (err) {
      this.logger.error('Failed to notify trade opening:', err);
    }
  }

  private async notifyTradeClosed(
    positionId: number,
    exitPrice: number,
    pnl: number,
    reason: string
  ): Promise<void> {
    try {
      await this.apiClient.post(`/api/trades/pos-${positionId}`, {
        exitPrice,
        pnl,
        reason,
        status: 'closed'
      });
      this.logger.info(`Trade closed notification sent for position ${positionId}`);
    } catch (err) {
      this.logger.error('Failed to notify trade closing:', err);
    }
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
