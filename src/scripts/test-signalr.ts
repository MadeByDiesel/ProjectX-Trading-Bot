import { ProjectXClient } from '../services/projectx-client';
import { Logger } from '../utils/logger';
import { ProjectXConfig } from '../types';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

const logger = new Logger('SignalRTest');

async function testSignalR() {
  try {
    // Use EXISTING environment variables
    if (!process.env.PROJECTX_API_KEY || !process.env.PROJECTX_USERNAME) {
      throw new Error('Missing PROJECTX_API_KEY or PROJECTX_USERNAME environment variables. Check your .env file');
    }

    const config: ProjectXConfig = {
      apiKey: process.env.PROJECTX_API_KEY,
      userName: process.env.PROJECTX_USERNAME,
      baseURL: 'https://api.topstepx.com'
    };

    logger.info('Environment variables loaded successfully');
    logger.info(`Username: ${config.userName}`);
    logger.info(`API Key: ${config.apiKey ? '***' + config.apiKey.slice(-4) : 'Not set'}`);

    const client = new ProjectXClient(config);

    logger.info('Initializing client...');
    await client.initialize();
    
    logger.info('Connecting to SignalR...');
    await client.connectWebSocket();
    
    logger.info('Subscribing to MNQ market data...');
    await client.subscribeToSymbols(['MNQ']);
    
    // Event handlers
    client.onMarketData((data) => {
      logger.info(`Market data: ${data.symbol} - Bid: ${data.bestBid}, Ask: ${data.bestAsk}, Last: ${data.lastPrice}`);
    });

    client.onOrderUpdate((order) => {
      logger.info(`Order update: ${order.id} - Status: ${order.status}, Type: ${order.type}`);
    });

    client.onPositionUpdate((position) => {
      logger.info(`Position update: ${position.id} - Size: ${position.size}, Avg Price: ${position.averagePrice}`);
    });

    client.onAccountUpdate((account) => {
      logger.info(`Account update: ${account.name} - Balance: ${account.balance}`);
    });

    client.onConnected(() => {
      logger.info('✅ SignalR connection established and ready');
    });

    logger.info('SignalR test running - waiting for real-time data...');
    setTimeout(() => {
      logger.info('SignalR test completed successfully');
      process.exit(0);
    }, 30000);

  } catch (error) {
    logger.error('SignalR test failed:', error);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  logger.info('Shutting down SignalR test...');
  process.exit(0);
});

testSignalR();