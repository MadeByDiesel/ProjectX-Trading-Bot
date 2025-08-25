import { ProjectXClient } from './projectx-client';
import { ProjectXConfig } from '../types';

let authenticatedClient: ProjectXClient | null = null;

export const initializeClient = async (config: ProjectXConfig): Promise<ProjectXClient> => {
  if (!authenticatedClient) {
    authenticatedClient = new ProjectXClient(config);
    await authenticatedClient.initialize();
  }
  return authenticatedClient;
};

export const getClient = (): ProjectXClient => {
  if (!authenticatedClient) {
    throw new Error('Client not initialized');
  }
  return authenticatedClient;
};

export const isClientInitialized = (): boolean => {
  return authenticatedClient !== null;
};