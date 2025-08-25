import express from 'express';
import { getClient } from '../../services/client-manager'; // Import from manager

const router = express.Router();

// Get all tradeable accounts
router.get('/', async (req, res) => {
  try {
    const client = getClient(); // Get the already-initialized client
    const accounts = await client.getAccounts();
    const tradeableAccounts = accounts.filter(account => account.canTrade === true);
    
    res.json(tradeableAccounts);
  } catch (error) {
    console.error('Account fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

export default router;