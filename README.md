# MNQ Delta Trend Trading Strategy for Topstep/ProjectX

A professional trading bot implementing the MNQ Delta Trend strategy on the Topstep/ProjectX API. This bot runs 24/7 and executes trades based on delta volume analysis and higher timeframe trend confirmation.

## 🚀 Features

- **Real-time Market Data**: WebSocket connection for live MNQ data
- **Delta Trend Strategy**: Exact implementation of Pine script strategy
- **Risk Management**: ATR-based position sizing and stop losses
- **Trading Hours**: Automatically trades only during market hours (9:30 AM - 4:00 PM EST)
- **Production Ready**: Proper error handling and graceful shutdown

## 📋 Prerequisites

- Node.js 18.0.0 or higher
- npm 8.0.0 or higher
- Topstep/ProjectX trading account
- API access enabled in your Topstep account

## 🔧 Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-username/projectx-mnq-delta-trend.git
   cd projectx-mnq-delta-trend


npm install

# Development mode
npm run dev

# Or build and start
npm run build
npm start

# Production Mode:
npm run build
npm start

# Debug Mode: 
npm run dev:debug

# Test health endpoint
curl http://localhost:3000/health

# Test market data
curl http://localhost:3000/api/marketdata/MNQ

# Test strategy status
curl http://localhost:3000/api/strategy/status


# The strategy is configured in src/strategies/mnq-delta-trend/config.ts:
export const MNQ_DELTA_CONFIG = {
  symbol: 'MNQ',
  contractSize: 2,
  tradingStartTime: "09:30",    // EST
  tradingEndTime: "16:00",      // EST
  primaryTimeframe: 3,          // 3 minutes
  higherTimeframe: 15,          // 15 minutes
  deltaThreshold: 1000,         // Minimum delta for signals
  atrPeriod: 14,                // ATR period
  riskPerTrade: 0.01,           // 1% risk per trade
  maxPositionSize: 5,           // Max contracts
  stopLossATRMultiplier: 1.5,   // 1.5x ATR stop loss
  takeProfitATRMultiplier: 2.0, // 2.0x ATR take profit
  maxDailyLoss: 0.05            // 5% max daily loss

  
};

# Strategy Logic
The MNQ Delta Trend strategy uses:

3-Minute Bars: Primary timeframe for entry signals

15-Minute Trend: Higher timeframe for trend confirmation

Volume Delta: Strong buying/selling pressure detection

ATR-based Risk: Dynamic position sizing and stop losses

Entry Conditions:
Long: Strong delta buying (+1000) + Bullish 15min trend

Short: Strong delta selling (-1000) + Bearish 15min trend

Exit Conditions:
Stop loss: 1.5x ATR from entry

Take profit: 2.0x ATR from entry

End of trading day: 4:00 PM EST

# Troubleshooting
Common Issues:
Authentication Failed

Verify PROJECTX_USERNAME and PROJECTX_API_KEY in .env

Check API key permissions in Topstep dashboard

WebSocket Connection Issues

Ensure firewall allows WebSocket connections (port 443)

Check internet connectivity

No Trading Activity

Verify trading hours (9:30 AM - 4:00 PM EST)

Check market data is being received

