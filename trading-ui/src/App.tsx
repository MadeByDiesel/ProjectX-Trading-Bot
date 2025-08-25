import React, { useState } from 'react';
import { 
  Container, 
  Typography, 
  Box, 
  Alert, 
  Paper, 
  Chip,
  Tabs,
  Tab
} from '@mui/material';
import AccountSelector from './components/AccountSelector';
import StrategyControl from './components/StrategyControl';
import TradeMonitor from './components/TradeMonitor';
import { Account, StrategyConfig } from './types/strategy';
import { defaultStrategyConfig } from './config/defaultConfig';
import { startStrategy, stopStrategy } from './services/api';
import './App.css';

// Tab panel component
interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`tabpanel-${index}`}
      aria-labelledby={`tab-${index}`}
      {...other}
    >
      {value === index && (
        <Box sx={{ py: 3 }}>
          {children}
        </Box>
      )}
    </div>
  );
}

function App() {
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [config, setConfig] = useState<StrategyConfig>(defaultStrategyConfig);
  const [isStrategyRunning, setIsStrategyRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [tabValue, setTabValue] = useState(0);

  const handleAccountSelect = (account: Account) => {
    setSelectedAccount(account);
  };

  const handleTabChange = (event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };

  const handleToggleStrategy = async () => {
    if (!selectedAccount) {
      setMessage('Please select an account first');
      return;
    }

    try {
      if (isStrategyRunning) {
        await stopStrategy();
        setIsStrategyRunning(false);
        setMessage('Strategy stopped successfully!');
      } else {
        await startStrategy({
          ...config,
          accountId: selectedAccount.id
        });
        setIsStrategyRunning(true);
        setMessage('Strategy started successfully!');
      }
    } catch (error) {
      setMessage(`Failed to ${isStrategyRunning ? 'stop' : 'start'} strategy: ` + (error as Error).message);
    }
  };

  return (
    <Container maxWidth="lg">
      <Box sx={{ my: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom align="center">
          Trading Strategy Manager
        </Typography>

        {message && (
          <Alert severity={message.includes('Failed') ? 'error' : 'success'} sx={{ mb: 3 }}>
            {message}
          </Alert>
        )}

        {/* Header Section - Using CSS Grid for equal height */}
        <Box sx={{ 
          display: 'grid', 
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, 
          gap: 3, 
          mb: 3,
          alignItems: 'stretch' // This makes items stretch to equal height
        }}>
          {/* Left Column - Account Selector */}
          <Paper elevation={3} sx={{ p: 3, display: 'flex', flexDirection: 'column' }}>
            <AccountSelector
              onAccountSelect={handleAccountSelect}
              selectedAccount={selectedAccount}
            />
          </Paper>

          {/* Right Column - Status and Control */}
          <Paper elevation={3} sx={{ p: 3, display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              alignItems: 'flex-start', 
              mb: 2 
            }}>
              <Box>
                <Typography variant="h6" gutterBottom>
                  Strategy Status
                </Typography>
                <Chip
                  label={isStrategyRunning ? "RUNNING" : "IDLE"}
                  color={isStrategyRunning ? "success" : "default"}
                  variant="filled"
                  size="medium"
                  sx={{ 
                    fontWeight: 'bold',
                    fontSize: '0.9rem',
                    px: 2
                  }}
                />
              </Box>
              
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                <Typography variant="body2" color="text.secondary" gutterBottom>
                  {selectedAccount ? `Account: ${selectedAccount.name}` : 'No account selected'}
                </Typography>
                <Chip
                  label={isStrategyRunning ? "STOP STRATEGY" : "START STRATEGY"}
                  color={isStrategyRunning ? "error" : "success"}
                  onClick={handleToggleStrategy}
                  disabled={!selectedAccount}
                  variant="filled"
                  sx={{ 
                    fontWeight: 'bold',
                    fontSize: '0.9rem',
                    px: 3,
                    py: 1,
                    minWidth: '140px'
                  }}
                />
              </Box>
            </Box>

            {/* Additional status information */}
            <Box sx={{ mt: 2, p: 2, bgcolor: 'grey.50', borderRadius: 1 }}>
              <Typography variant="body2" gutterBottom>
                <strong>Current Symbol:</strong> MNQ
              </Typography>
              <Typography variant="body2" gutterBottom>
                <strong>Session:</strong> {config.tradingStartTime} - {config.tradingEndTime} ET
              </Typography>
              <Typography variant="body2">
                <strong>Contracts:</strong> {config.contractQuantity}
              </Typography>
            </Box>
          </Paper>
        </Box>

        {/* Tabbed Content Section - Centered with proper spacing */}
        {selectedAccount && (
          <Box sx={{ width: '100%', display: 'flex', justifyContent: 'center', mt: 2 }}>
            <Paper elevation={0} sx={{ width: '100%', maxWidth: '1200px' }}>
              <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
                <Tabs value={tabValue} onChange={handleTabChange} centered>
                  <Tab label="Configuration" />
                  <Tab label="Trade Monitor" />
                </Tabs>
              </Box>

              <TabPanel value={tabValue} index={0}>
                <StrategyControl
                  config={config}
                  onConfigChange={setConfig}
                  isStrategyRunning={isStrategyRunning}
                />
              </TabPanel>

              <TabPanel value={tabValue} index={1}>
                <TradeMonitor isStrategyRunning={isStrategyRunning} />
              </TabPanel>
            </Paper>
          </Box>
        )}
      </Box>
    </Container>
  );
}

export default App;