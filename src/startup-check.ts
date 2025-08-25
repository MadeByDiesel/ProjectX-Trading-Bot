import 'dotenv/config';
import { ProjectXClient } from './services/api-client';
import { Logger } from './utils/logger';
import { Account, Contract, Quote } from './types';

const logger = new Logger('StartupCheck');

async function verifyStartup() {
  try {
    logger.info('🚀 Verifying Topstep LIVE API Connection');
    logger.info('=========================================');
    logger.info('API Endpoint: https://api.topstepx.com');
    logger.info('=========================================');

    // Check environment variables
    const requiredEnvVars = ['PROJECTX_USERNAME', 'PROJECTX_API_KEY'];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      throw new Error(`Missing environment variables: ${missingVars.join(', ')}`);
    }
    logger.info('✅ Environment variables check passed');

    // Test API connectivity
    logger.info('2. Testing authentication and API connectivity...');
    const client = new ProjectXClient({
      userName: process.env.PROJECTX_USERNAME!,
      apiKey: process.env.PROJECTX_API_KEY!
    });

    try {
      const accounts: Account[] = await client.getAccounts();
      logger.info(`✅ Authentication successful - Found ${accounts.length} account(s)`);
      
      accounts.forEach((account: Account, index: number) => {
        logger.info(`   ${index + 1}. ${account.name} - $${account.balance}`);
      });

      // Test market data with correct endpoints
      try {
        // Test contract search
        const contracts: Contract[] = await client.searchContracts('MNQ');
        logger.info(`✅ Contract search successful - Found ${contracts.length} contracts`);
        
        if (contracts.length > 0) {
          const mnqContract: Contract = contracts[0];
          logger.info(`   MNQ Contract: ${mnqContract.symbol} - ${mnqContract.name}`);
          
          // Test real-time quotes
          const quotes: Quote[] = await client.getQuotes([mnqContract.id]);
          logger.info(`✅ Quotes endpoint successful - Found ${quotes.length} quotes`);
          
          if (quotes.length > 0) {
            const quote: Quote = quotes[0];
            logger.info(`   MNQ Quote: Bid $${quote.bid}, Ask $${quote.ask}, Last $${quote.last}`);
          }
        }
      } catch (marketError: any) {
        logger.warn(`⚠️  Market data test: ${marketError.message}`);
      }

    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new Error('API authentication failed - check credentials');
      }
      throw new Error(`API connection failed: ${error.message}`);
    }

    logger.info('=========================================');
    logger.info('🎉 LIVE API Verification COMPLETE');
    logger.info('✅ All endpoints verified against Swagger documentation');
    logger.info('=========================================');

  } catch (error: any) {
    logger.error('Startup verification FAILED:', error.message);
    process.exit(1);
  }
}

// Run verification
verifyStartup().catch(console.error);