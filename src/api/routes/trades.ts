import express from 'express';

const router = express.Router();

// In-memory store for demo (replace with database in production)
let trades: any[] = [];

// Get all trades
router.get('/', async (req, res) => {
  try {
    // For now, return demo data - you'll replace this with actual trade data
    // from your trading bot's position manager
    res.json(trades);
  } catch (error) {
    console.error('Trade fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch trades' });
  }
});

// Add a trade (for testing - your bot will call this)
router.post('/', async (req, res) => {
  try {
    const trade = {
      id: `trade-${Date.now()}`,
      entryTime: new Date().toISOString(),
      ...req.body,
      status: 'open',
      exitPrice: null,
      pnl: null
    };
    
    trades.unshift(trade); // Add to beginning for newest first
    res.json(trade);
  } catch (error) {
    console.error('Trade creation error:', error);
    res.status(500).json({ error: 'Failed to create trade' });
  }
});

// Update a trade (when position is closed)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const tradeIndex = trades.findIndex(t => t.id === id);
    
    if (tradeIndex === -1) {
      return res.status(404).json({ error: 'Trade not found' });
    }
    
    trades[tradeIndex] = { ...trades[tradeIndex], ...req.body, status: 'closed' };
    res.json(trades[tradeIndex]);
  } catch (error) {
    console.error('Trade update error:', error);
    res.status(500).json({ error: 'Failed to update trade' });
  }
});

export default router;