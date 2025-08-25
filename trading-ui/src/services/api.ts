import axios from 'axios';
import { Trade } from '../types/strategy'; // Add this import

const API_BASE_URL = 'http://localhost:3001/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
});

// Health check
export const checkHealth = async () => {
  const response = await api.get('/health');
  return response.data;
};

// Get tradeable accounts
export const getAccounts = async () => {
  const response = await api.get('/accounts');
  return response.data;
};

// Get trades
export const getTrades = async (): Promise<Trade[]> => {
  const response = await api.get('/trades');
  return response.data;
};

// Add these for future use:
export const createTrade = async (trade: Partial<Trade>): Promise<Trade> => {
  const response = await api.post('/trades', trade);
  return response.data;
};

export const updateTrade = async (id: string, updates: Partial<Trade>): Promise<Trade> => {
  const response = await api.put(`/trades/${id}`, updates);
  return response.data;
};

// Start strategy
export const startStrategy = async (config: any) => {
  const response = await api.post('/strategy/start', config);
  return response.data;
};

// Stop strategy
export const stopStrategy = async () => {
  const response = await api.post('/strategy/stop');
  return response.data;
};

// Get strategy config
export const getStrategyConfig = async (): Promise<any> => {
  const response = await api.get('/strategy/config');
  return response.data;
};

export default api;