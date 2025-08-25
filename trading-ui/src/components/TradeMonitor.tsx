import React, { useState, useEffect, useCallback } from 'react';
import {
  Paper,
  Typography,
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  IconButton,
  CircularProgress
} from '@mui/material';
import { Refresh } from '@mui/icons-material';
import { getTrades } from '../services/api';
import { Trade } from '../types/strategy';

interface TradeMonitorProps {
  isStrategyRunning: boolean;
}

const TradeMonitor: React.FC<TradeMonitorProps> = ({ isStrategyRunning }) => {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());

  const fetchTrades = useCallback(async () => {
    if (!isStrategyRunning) return;
    
    setLoading(true);
    try {
      const tradesData = await getTrades();
      setTrades(tradesData);
      setLastUpdated(new Date());
    } catch (error) {
      console.error('Failed to fetch trades:', error);
    } finally {
      setLoading(false);
    }
  }, [isStrategyRunning]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    
    if (isStrategyRunning) {
      fetchTrades();
      interval = setInterval(fetchTrades, 3000);
    } else {
      setTrades([]);
    }
    
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isStrategyRunning, fetchTrades]);

  const formatCurrency = (value: number | null) => {
    if (value === null) return '-';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value);
  };

  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  const getPnlColor = (pnl: number | null) => {
    if (pnl === null) return 'default';
    return pnl >= 0 ? 'success' : 'error';
  };

  const getDirectionColor = (direction: 'long' | 'short') => {
    return direction === 'long' ? 'success' : 'error';
  };

  return (
    <Paper elevation={1} sx={{ p: 3, mb: 3 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6">Trade Monitor</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Typography variant="body2" color="text.secondary">
            {isStrategyRunning ? `Last update: ${lastUpdated.toLocaleTimeString()}` : 'Strategy not running'}
          </Typography>
          <IconButton 
            onClick={fetchTrades} 
            size="small" 
            title="Refresh trades"
            disabled={!isStrategyRunning}
          >
            <Refresh />
          </IconButton>
        </Box>
      </Box>

      {loading ? (
        <Box sx={{ textAlign: 'center', py: 3 }}>
          <CircularProgress size={24} sx={{ mr: 2 }} />
          <Typography variant="body1">Loading trades...</Typography>
        </Box>
      ) : (
        <>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Time</TableCell>
                  <TableCell>Contract</TableCell>
                  <TableCell>Direction</TableCell>
                  <TableCell>Qty</TableCell>
                  <TableCell>Entry</TableCell>
                  <TableCell>Exit</TableCell>
                  <TableCell>PnL</TableCell>
                  <TableCell>Reason</TableCell>
                  <TableCell>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {trades.map((trade) => (
                  <TableRow key={trade.id} hover>
                    <TableCell>{formatTime(trade.entryTime)}</TableCell>
                    <TableCell>
                      <Chip label={trade.contract} size="small" variant="outlined" />
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={trade.direction.toUpperCase()}
                        color={getDirectionColor(trade.direction)}
                        size="small"
                      />
                    </TableCell>
                    <TableCell>{trade.quantity}</TableCell>
                    <TableCell>{formatCurrency(trade.entryPrice)}</TableCell>
                    <TableCell>{formatCurrency(trade.exitPrice)}</TableCell>
                    <TableCell>
                      <Chip
                        label={formatCurrency(trade.pnl)}
                        color={getPnlColor(trade.pnl)}
                        size="small"
                        variant={trade.pnl === null ? "outlined" : "filled"}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontSize: '0.8rem', maxWidth: 120 }}>
                        {trade.reason}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={trade.status.toUpperCase()}
                        color={trade.status === 'open' ? 'primary' : 'default'}
                        size="small"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          {trades.length === 0 && (
            <Box sx={{ textAlign: 'center', py: 4 }}>
              <Typography variant="body1" color="text.secondary" gutterBottom>
                {isStrategyRunning ? 'No trades yet' : 'Strategy not running'}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {isStrategyRunning 
                  ? 'Waiting for trading signals...' 
                  : 'Start the strategy to see trading activity'
                }
              </Typography>
              {isStrategyRunning && (
                <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                  Trades will appear here when executed
                </Typography>
              )}
            </Box>
          )}

          {isStrategyRunning && trades.length > 0 && (
            <Box sx={{ mt: 2, display: 'flex', justifyContent: 'space-between' }}>
              <Typography variant="body2" color="text.secondary">
                Total trades: {trades.length}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Open positions: {trades.filter(t => t.status === 'open').length}
              </Typography>
            </Box>
          )}
        </>
      )}
    </Paper>
  );
};

export default TradeMonitor;