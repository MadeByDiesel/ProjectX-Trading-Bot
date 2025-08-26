import React from 'react';
import {
  Paper,
  Typography,
  Box,
  TextField,
  Switch,
  FormControlLabel,
  Divider,
  FormControl,
  InputLabel,
  Select,
  MenuItem
} from '@mui/material';
import { StrategyConfig } from '../types/strategy';

interface StrategyControlProps {
  config: StrategyConfig;
  onConfigChange: (config: StrategyConfig) => void;
  isStrategyRunning: boolean;
}

const StrategyControl: React.FC<StrategyControlProps> = ({
  config,
  onConfigChange,
  isStrategyRunning
}) => {
  const handleInputChange = (field: keyof StrategyConfig) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    
    const fieldString = field.toString();
    const isTimeField = fieldString.includes('Time');
    
    onConfigChange({
      ...config,
      [field]: isTimeField ? value : Number(value)
    });
  };

  const handleSelectChange = (field: keyof StrategyConfig) => (event: any) => {
    onConfigChange({
      ...config,
      [field]: event.target.value
    });
  };

  return (
    <Paper elevation={3} sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom sx={{ mb: 2 }}>
        MNQ Delta Trend Configuration
      </Typography>

      {/* Session Times - Compact 2 columns */}
      <Box sx={{ mb: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          Session Times (ET)
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
          <TextField
            size="small"
            label="Start Time"
            type="time"
            value={config.tradingStartTime}
            onChange={handleInputChange('tradingStartTime')}
            InputLabelProps={{ shrink: true }}
            disabled={isStrategyRunning}
          />
          <TextField
            size="small"
            label="End Time"
            type="time"
            value={config.tradingEndTime}
            onChange={handleInputChange('tradingEndTime')}
            InputLabelProps={{ shrink: true }}
            disabled={isStrategyRunning}
          />
        </Box>
      </Box>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 1, mb: 1 }}>
        <TextField
          size="small"
          label="Contracts"
          type="number"
          value={config.contractQuantity}
          onChange={handleInputChange('contractQuantity')}
          inputProps={{ min: 1, max: 100 }}
          disabled={isStrategyRunning}
        />
        <TextField
          size="small"
          label="Daily Target $"
          type="number"
          value={config.dailyProfitTarget}
          onChange={handleInputChange('dailyProfitTarget')}
          disabled={isStrategyRunning}
        />
        <TextField
          size="small"
          label="Max Drawdown $"
          type="number"
          value={config.maxTotalDrawdown}
          onChange={handleInputChange('maxTotalDrawdown')}
          disabled={isStrategyRunning}
        />
        <TextField
          size="small"
          label="Daily Drawdown $"
          type="number"
          value={config.maxDailyDrawdown}
          onChange={handleInputChange('maxDailyDrawdown')}
          disabled={isStrategyRunning}
        />
      </Box>

      <Divider sx={{ my: 1 }} />

      {/* Delta Configuration - 4 columns */}
      <Typography variant="subtitle2" gutterBottom>
        Delta Configuration
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 1, mb: 1 }}>
        <TextField
          size="small"
          label="Delta SMA"
          type="number"
          value={config.deltaSMALength}
          onChange={handleInputChange('deltaSMALength')}
          inputProps={{ min: 1, max: 50 }}
          disabled={isStrategyRunning}
        />
        <TextField
          size="small"
          label="Delta Spike Threshold"
          type="number"
          value={config.deltaSpikeThreshold}
          onChange={handleInputChange('deltaSpikeThreshold')}
          inputProps={{ min: 1, max: 1000, step: 10 }}
          disabled={isStrategyRunning}
        />
        <TextField
          size="small"
          label="Delta Surge Mult"
          type="number"
          value={config.deltaSurgeMultiplier}
          onChange={handleInputChange('deltaSurgeMultiplier')}
          inputProps={{ min: 1.0, max: 3.0, step: 0.1 }}
          disabled={isStrategyRunning}
        />
        <TextField
          size="small"
          label="Breakout Lookback Bars"
          type="number"
          value={config.breakoutLookbackBars}
          onChange={handleInputChange('breakoutLookbackBars')}
          inputProps={{ min: 1, max: 200 }}
          disabled={isStrategyRunning}
        />
        <TextField
          size="small"
          label="Delta Slope Exit Length"
          type="number"
          value={config.deltaSlopeExitLength}
          onChange={handleInputChange('deltaSlopeExitLength')}
          inputProps={{ min: 1, max: 10 }}
          disabled={isStrategyRunning}
        />
      </Box>

      <Divider sx={{ my: 1 }} />

      {/* EMA Configuration - 4 columns */}
      <Typography variant="subtitle2" gutterBottom>
        EMA Configuration
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 1, mb: 1 }}>
        <TextField
          size="small"
          label="EMA Length"
          type="number"
          value={config.emaLength}
          onChange={handleInputChange('emaLength')}
          inputProps={{ min: 1, max: 20 }}
          disabled={isStrategyRunning}
        />
        <TextField
          size="small"
          label="HTF EMA"
          type="number"
          value={config.htfEMALength}
          onChange={handleInputChange('htfEMALength')}
          inputProps={{ min: 5, max: 50 }}
          disabled={isStrategyRunning}
        />
        <TextField
          size="small"
          label="HTF Minutes"
          type="number"
          value={config.higherTimeframe}
          onChange={handleInputChange('higherTimeframe')}
          inputProps={{ min: 15, max: 240 }}
          disabled={isStrategyRunning}
        />
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>EMA Filter</InputLabel>
          <Select
            value={config.useEmaFilter ? 'true' : 'false'}
            onChange={handleSelectChange('useEmaFilter')}
            label="EMA Filter"
            disabled={isStrategyRunning}
          >
            <MenuItem value="true">Enabled</MenuItem>
            <MenuItem value="false">Disabled</MenuItem>
          </Select>
        </FormControl>
      </Box>

      <Divider sx={{ my: 1 }} />

      {/* ATR & Exit Configuration - 4 columns */}
      <Typography variant="subtitle2" gutterBottom>
        ATR & Exit Configuration
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 1, mb: 1 }}>
        <TextField
          size="small"
          label="ATR Profit Mult"
          type="number"
          value={config.atrProfitMultiplier}
          onChange={handleInputChange('atrProfitMultiplier')}
          inputProps={{ min: 0.1, max: 10, step: 0.1 }}
          disabled={isStrategyRunning}
        />
        <TextField
          size="small"
          label="ATR SL Mult"
          type="number"
          value={config.atrStopLossMultiplier}
          onChange={handleInputChange('atrStopLossMultiplier')}
          inputProps={{ min: 0.1, max: 10, step: 0.1 }}
          disabled={isStrategyRunning}
        />
        <TextField
          size="small"
          label="Min ATR"
          type="number"
          value={config.minAtrToTrade}
          onChange={handleInputChange('minAtrToTrade')}
          inputProps={{ min: 0.01, max: 30 }}
          disabled={isStrategyRunning}
        />
        <TextField
          size="small"
          label="Min Bars Exit"
          type="number"
          value={config.minBarsBeforeExit}
          onChange={handleInputChange('minBarsBeforeExit')}
          inputProps={{ min: 0, max: 20 }}
          disabled={isStrategyRunning}
        />
      </Box>

      <Divider sx={{ my: 1 }} />

      {/* Trailing Stop Configuration - 4 columns */}
      <Typography variant="subtitle2" gutterBottom>
        Trailing Stop
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 1, mb: 1 }}>
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>Trailing</InputLabel>
          <Select
            value={config.useTrailingStop ? 'true' : 'false'}
            onChange={handleSelectChange('useTrailingStop')}
            label="Trailing"
            disabled={isStrategyRunning}
          >
            <MenuItem value="true">Enabled</MenuItem>
            <MenuItem value="false">Disabled</MenuItem>
          </Select>
        </FormControl>
        <TextField
          size="small"
          label="Trail Activation (ATR Mult)"
          type="number"
          value={config.trailActivationATR}
          onChange={handleInputChange('trailActivationATR')}
          inputProps={{ min: 0.1, max: 10.0, step: 0.1 }}
          disabled={!config.useTrailingStop || isStrategyRunning}
        />
        <TextField
          size="small"
          label="Trail Offset (ATR Multi)"
          type="number"
          value={config.trailOffsetATR}
          onChange={handleInputChange('trailOffsetATR')}
          inputProps={{ min: 0.1, max: 10.0, step: 0.1 }}
          disabled={!config.useTrailingStop || isStrategyRunning}
        />
      </Box>

      <Divider sx={{ my: 1 }} />

      {/* Position Sizing & Risk Management - 4 columns */}
      {/* <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 1, mb: 1 }}>
        <TextField
          size="small"
          label="Contracts"
          type="number"
          value={config.contractQuantity}
          onChange={handleInputChange('contractQuantity')}
          inputProps={{ min: 1, max: 100 }}
          disabled={isStrategyRunning}
        />
        <TextField
          size="small"
          label="Daily Target $"
          type="number"
          value={config.dailyProfitTarget}
          onChange={handleInputChange('dailyProfitTarget')}
          disabled={isStrategyRunning}
        />
        <TextField
          size="small"
          label="Max Drawdown $"
          type="number"
          value={config.maxTotalDrawdown}
          onChange={handleInputChange('maxTotalDrawdown')}
          disabled={isStrategyRunning}
        />
        <TextField
          size="small"
          label="Daily Drawdown $"
          type="number"
          value={config.maxDailyDrawdown}
          onChange={handleInputChange('maxDailyDrawdown')}
          disabled={isStrategyRunning}
        />
      </Box> */}
    </Paper>
  );
};

export default StrategyControl;
