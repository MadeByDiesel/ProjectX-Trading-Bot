import React, { useState, useEffect } from 'react';
import {
  Box,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Typography,
  Paper
} from '@mui/material';
import { Account } from '../types/strategy';
import { getAccounts } from '../services/api';

interface AccountSelectorProps {
  onAccountSelect: (account: Account) => void;
  selectedAccount: Account | null;
}

const AccountSelector: React.FC<AccountSelectorProps> = ({
  onAccountSelect,
  selectedAccount
}) => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadAccounts = async () => {
      try {
        const accountsData = await getAccounts();
        setAccounts(accountsData);
        if (accountsData.length > 0 && !selectedAccount) {
          onAccountSelect(accountsData[0]); // Auto-select first account
        }
      } catch (error) {
        console.error('Failed to load accounts:', error);
      } finally {
        setLoading(false);
      }
    };

    loadAccounts();
  }, [onAccountSelect, selectedAccount]);

  if (loading) {
    return <Typography>Loading accounts...</Typography>;
  }

  return (
    <Paper elevation={1} sx={{ p: 3, mb: 3 }}>
      <Typography variant="h6" gutterBottom>
        Select Trading Account
      </Typography>
      
      <FormControl fullWidth>
        <InputLabel>Tradeable Accounts</InputLabel>
        <Select
          value={selectedAccount?.id || ''}
          onChange={(e) => {
            const account = accounts.find(acc => acc.id === e.target.value);
            if (account) onAccountSelect(account);
          }}
          label="Tradeable Accounts"
        >
          {accounts.map((account) => (
            <MenuItem key={account.id} value={account.id}>
              {account.name} - ${account.balance.toLocaleString()} 
              {account.simulated ? ' (Simulated)' : ''}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {selectedAccount && (
        <Box sx={{ mt: 2, p: 2, borderRadius: 1 }}>
          <Typography variant="subtitle1">
            ✅ Selected: {selectedAccount.name}
          </Typography>
          <Typography variant="body2">
            Balance: ${selectedAccount.balance.toLocaleString()}
          </Typography>
          <Typography variant="body2">
            Status: {selectedAccount.canTrade ? 'Tradeable' : 'Not Tradeable'}
          </Typography>
        </Box>
      )}
    </Paper>
  );
};

export default AccountSelector;