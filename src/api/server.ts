import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import accountsRouter from './routes/accounts';
import tradesRouter from './routes/trades';
import strategyRouter from './routes/strategy';

const app = express();
const PORT = 3001;

// Middleware
app.use(cors({
  origin: 'http://localhost:3000', // React app will run here
  credentials: true
}));
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json());

// Routes
app.use('/api/accounts', accountsRouter);
app.use('/api/trades', tradesRouter);
app.use('/api/strategy', strategyRouter);

// Health endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'ProjectX Trading API'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`📡 API Server running on http://localhost:${PORT}`);
});

export default app;