// src/index.ts
import { initializeClient } from './services/client-manager';
import { Logger } from './utils/logger';
import { Account, ProjectXConfig } from './types';
import * as dotenv from 'dotenv';
import './api/server';

console.log('🚀 Starting ProjectX Trading Bot and API Server...');
dotenv.config();

const logger = new Logger('MainApp');

const config: ProjectXConfig = {
  baseURL: process.env.API_BASE_URL || 'https://api.topstepx.com',
  userName: process.env.PROJECTX_USERNAME || '',
  apiKey: process.env.PROJECTX_API_KEY || ''
};

async function main() {
  try {
    logger.info('🚀 Starting ProjectX MNQ Delta Trend Trading Bot');
    logger.info('=============================================');

    if (!config.apiKey || !config.userName) {
      throw new Error('Missing PROJECTX_API_KEY or PROJECTX_USERNAME environment variables');
    }

    // Initialize the shared client used by the API + UI-triggered strategy
    const client = await initializeClient(config);

    // Show accounts for visibility
    const accounts = await client.getAccounts();
    logger.info(`Found ${accounts.length} account(s):`);
    accounts.forEach((account: Account, index: number) => {
      logger.info(`  ${index + 1}. ${account.name} - $${account.balance.toFixed(2)}`);
    });

    // IMPORTANT: Do not start the strategy here.
    // The UI will start/stop the strategy to avoid duplicate instances.
    logger.info('✅ API server is up. Strategy will be started/stopped via the UI.');

    // Graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Shutting down trading bot...');
      try {
        if (client.isWebSocketConnected()) {
          await client.disconnectWebSocket();
        }
      } catch (err) {
        logger.error('Error during shutdown:', err);
      }
      logger.info('Trading bot stopped gracefully');
      process.exit(0);
    });

  } catch (error) {
    logger.error('Failed to start trading bot:', error);
    process.exit(1);
  }
}

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

main().catch(error => {
  logger.error('Unhandled error in main:', error);
  process.exit(1);
});
