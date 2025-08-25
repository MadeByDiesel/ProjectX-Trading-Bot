import express from 'express';
import { getClient } from '../../services/client-manager';
import { MNQDeltaTrendTrader } from '../../strategies/mnq-delta-trend/trader';
import { Logger } from '../../utils/logger';

const router = express.Router();
const logger = new Logger('StrategyRoute');

let activeTrader: MNQDeltaTrendTrader | null = null;

// Start strategy
router.post('/start', async (req, res) => {
  try {
    const config = req.body;
    
    // Validate required configuration fields
    if (!config.symbol || typeof config.symbol !== 'string' || config.symbol.trim() === '') {
      throw new Error('Strategy configuration must include a valid symbol');
    }

    if (!config.tradingStartTime || !config.tradingEndTime) {
      throw new Error('Strategy configuration must include trading session times');
    }

    if (typeof config.contractQuantity !== 'number' || config.contractQuantity <= 0) {
      throw new Error('Strategy configuration must include valid contract quantity');
    }

    const client = getClient();
    
    // Validate client is available
    if (!client) {
      throw new Error('Trading client not available');
    }

    activeTrader = new MNQDeltaTrendTrader(
      client,
      'http://localhost:3001',
      config
    );
    
    await activeTrader.start();
    
    logger.info(`Strategy started successfully for symbol: ${config.symbol}`);
    
    res.json({ 
      success: true, 
      message: 'Strategy started successfully',
      config 
    });
  } catch (error) {
    const errorMessage = 'Failed to start strategy: ' + (error as Error).message;
    logger.error(errorMessage, error);
    res.status(500).json({ 
      success: false,
      error: errorMessage 
    });
  }
});

// Stop strategy
router.post('/stop', async (req, res) => {
  try {
    if (activeTrader) {
      activeTrader.stop();
      activeTrader = null;
      logger.info('Strategy stopped successfully');
    }
    
    res.json({ 
      success: true, 
      message: 'Strategy stopped successfully' 
    });
  } catch (error) {
    const errorMessage = 'Failed to stop strategy: ' + (error as Error).message;
    logger.error(errorMessage, error);
    res.status(500).json({ 
      success: false,
      error: errorMessage 
    });
  }
});

// Get strategy status
router.get('/status', async (req, res) => {
  try {
    res.json({
      isRunning: activeTrader !== null,
      trader: activeTrader ? {
        isWarmUpComplete: activeTrader.getWarmUpStatus(),
        contractId: activeTrader.getContractId()
      } : null
    });
  } catch (error) {
    const errorMessage = 'Failed to get strategy status: ' + (error as Error).message;
    logger.error(errorMessage, error);
    res.status(500).json({ 
      success: false,
      error: errorMessage 
    });
  }
});

export default router;



// import express from 'express';
// import { getClient } from '../../services/client-manager';
// import { MNQDeltaTrendTrader } from '../../strategies/mnq-delta-trend/trader';

// const router = express.Router();

// let activeTrader: MNQDeltaTrendTrader | null = null;

// // Start strategy
// router.post('/start', async (req, res) => {
//   try {
//     const config = req.body;
    
//     const client = getClient();
//     activeTrader = new MNQDeltaTrendTrader(
//       client,
//       'http://localhost:3001', // Add the base URL for your internal API
//       config);
//     await activeTrader.start();
    
//     res.json({ 
//       success: true, 
//       message: 'Strategy started successfully',
//       config 
//     });
//   } catch (error) {
//     console.error('Strategy start error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to start strategy: ' + (error as Error).message 
//     });
//   }
// });

// // Stop strategy
// // router.post('/stop', async (req, res) => {
//   try {
//     if (activeTrader) {
//       activeTrader.stop();
//       activeTrader = null;
//     }
    
//     res.json({ 
//       success: true, 
//       message: 'Strategy stopped successfully' 
//     });
//   } catch (error) {
//     console.error('Strategy stop error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to stop strategy: ' + (error as Error).message 
//     });
//   }
// });

// // Get strategy status
// router.get('/status', async (req, res) => {
//   res.json({
//     isRunning: activeTrader !== null,
//     trader: activeTrader ? {
//       isWarmUpComplete: activeTrader.getWarmUpStatus(),
//       contractId: activeTrader.getContractId()
//     } : null
//   });
// });

// export default router;