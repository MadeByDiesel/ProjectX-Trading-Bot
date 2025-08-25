import { initializeClient, getClient } from './services/client-manager';
import { ProjectXClient } from './services/projectx-client';
import { MarketDataService } from './services/market-data.service';
import { ApiService } from './services/api.service';
import { MNQDeltaTrendTrader } from './strategies/mnq-delta-trend/trader';
import { MNQ_DELTA_TREND_CONFIG } from './strategies/mnq-delta-trend/config';
import { Logger } from './utils/logger';
import { Account, ProjectXConfig } from './types';
import * as dotenv from 'dotenv';
import './api/server';

console.log('🚀 Starting ProjectX Trading Bot and API Server...');
// Load environment variables
dotenv.config();

const logger = new Logger('MainApp');

// Your configuration
const config: ProjectXConfig = {
  baseURL: process.env.API_BASE_URL || 'https://api.topstepx.com',
  userName: process.env.PROJECTX_USERNAME || '',
  apiKey: process.env.PROJECTX_API_KEY || ''
};

async function main() {
  try {
    logger.info('🚀 Starting ProjectX MNQ Delta Trend Trading Bot');
    logger.info('=============================================');

    // Check environment variables
    if (!config.apiKey || !config.userName) {
      throw new Error('Missing PROJECTX_API_KEY or PROJECTX_USERNAME environment variables');
    }

    // Initialize client using the client manager
    const client = await initializeClient(config);
    
    logger.info('Initializing trading bot...');
    
    // Get and display account information
    const accounts = await client.getAccounts();
    logger.info(`Found ${accounts.length} account(s):`);
    
    accounts.forEach((account: Account, index: number) => {
      logger.info(`  ${index + 1}. ${account.name} - $${account.balance.toFixed(2)}`);
    });

    // Create and start strategy - FIXED: Pass base URL string
    logger.info('Starting MNQ Delta Trend strategy...');
    const strategy = new MNQDeltaTrendTrader(
      client, 
      'http://localhost:3001', // Your internal API base URL
      MNQ_DELTA_TREND_CONFIG
    );
    
    await strategy.start();
    
    logger.info('✅ Trading bot started successfully');
    logger.info('Waiting for market data and trading signals...');


    // Graceful shutdown handling
    process.on('SIGINT', async () => {
      logger.info('Shutting down trading bot...');
      strategy.stop();
      await client.disconnectWebSocket();
      logger.info('Trading bot stopped gracefully');
      process.exit(0);
    });

  } catch (error) {
    logger.error('Failed to start trading bot:', error);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the application
main().catch(error => {
  logger.error('Unhandled error in main:', error);
  process.exit(1);
});