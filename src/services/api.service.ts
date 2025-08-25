import { ApiClient } from './api-client';
import {
  LoginCredentials,
  AuthResponse,
  AccountSearchRequest,
  AccountSearchResponse,
  ContractSearchRequest,
  ContractSearchResponse,
  ContractSearchByIdRequest,
  ContractSearchByIdResponse,
  RetrieveBarsRequest,
  RetrieveBarsResponse,
  OrderSearchResponse,
  OrderPlaceResponse,
  PositionSearchResponse,
  ApiResponseBase,
  Contract
} from '../types';

export class ApiService {
  private apiClient: ApiClient;

  constructor(baseURL: string) {
    this.apiClient = new ApiClient(baseURL);
  }

  async authenticate(credentials: LoginCredentials): Promise<AuthResponse> {
    try {
      // The API expects { userName, apiKey } without appId/appVersion
      const authRequest = {
        userName: credentials.userName,
        apiKey: credentials.apiKey
      };
      
      const response = await this.apiClient.post<AuthResponse>('/api/Auth/loginKey', authRequest);
      this.apiClient.setAuthToken(response.token);
      return response;
    } catch (error) {
      throw new Error(`Authentication failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Add this method to ApiService class in api.service.ts
  async searchAccounts(request: AccountSearchRequest): Promise<AccountSearchResponse> {
    try {
      const response = await this.apiClient.authPost<AccountSearchResponse>('/api/Account/search', request);
      if (!response.success) {
        throw new Error(`Account search failed: ${response.errorMessage}`);
      }
      return response;
    } catch (error) {
      throw new Error(`Account search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async searchContracts(request: ContractSearchRequest): Promise<ContractSearchResponse> {
    try {
      const response = await this.apiClient.authPost<ContractSearchResponse>('/api/Contract/search', request);
      if (!response.success) {
        throw new Error(`Contract search failed: ${response.errorMessage}`);
      }
      return response;
    } catch (error) {
      throw new Error(`Contract search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async searchContractById(request: ContractSearchByIdRequest): Promise<Contract> {
    try {
      const response = await this.apiClient.authPost<ContractSearchByIdResponse>('/api/Contract/searchById', request);
      if (!response.success) {
        throw new Error(`Contract search by ID failed: ${response.errorMessage}`);
      }
      return response.contract;
    } catch (error) {
      throw new Error(`Contract search by ID failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async retrieveBars(request: RetrieveBarsRequest): Promise<RetrieveBarsResponse> {
    try {
      const response = await this.apiClient.authPost<RetrieveBarsResponse>('/api/History/retrieveBars', request);
      if (!response.success) {
        throw new Error(`Retrieve bars failed: ${response.errorMessage}`);
      }
      return response;
    } catch (error) {
      throw new Error(`Retrieve bars failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async searchOrders(request: { accountId: number; startTimestamp?: string; endTimestamp?: string }): Promise<OrderSearchResponse> {
    try {
      const response = await this.apiClient.authPost<OrderSearchResponse>('/api/Order/search', request);
      if (!response.success) {
        throw new Error(`Order search failed: ${response.errorMessage}`);
      }
      return response;
    } catch (error) {
      throw new Error(`Order search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async searchOpenOrders(request: { accountId: number }): Promise<OrderSearchResponse> {
    try {
      const response = await this.apiClient.authPost<OrderSearchResponse>('/api/Order/searchOpen', request);
      if (!response.success) {
        throw new Error(`Open order search failed: ${response.errorMessage}`);
      }
      return response;
    } catch (error) {
      throw new Error(`Open order search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async placeOrder(request: {
    accountId: number;
    contractId: string;
    type: number;
    side: number;
    size: number;
    limitPrice?: number;
    stopPrice?: number;
    trailPrice?: number;
    customTag?: string;
    linkedOrderId?: number;
  }): Promise<OrderPlaceResponse> {
    try {
      const response = await this.apiClient.authPost<OrderPlaceResponse>('/api/Order/place', request);
      if (!response.success) {
        throw new Error(`Order placement failed: ${response.errorMessage}`);
      }
      return response;
    } catch (error) {
      throw new Error(`Order placement failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async cancelOrder(request: { accountId: number; orderId: number }): Promise<ApiResponseBase> {
    try {
      const response = await this.apiClient.authPost<ApiResponseBase>('/api/Order/cancel', request);
      if (!response.success) {
        throw new Error(`Order cancellation failed: ${response.errorMessage}`);
      }
      return response;
    } catch (error) {
      throw new Error(`Order cancellation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async searchOpenPositions(request: { accountId: number }): Promise<PositionSearchResponse> {
    try {
      const response = await this.apiClient.authPost<PositionSearchResponse>('/api/Position/searchOpen', request);
      if (!response.success) {
        throw new Error(`Open position search failed: ${response.errorMessage}`);
      }
      return response;
    } catch (error) {
      throw new Error(`Open position search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async closePosition(request: { accountId: number; contractId: string }): Promise<ApiResponseBase> {
    try {
      const response = await this.apiClient.authPost<ApiResponseBase>('/api/Position/closeContract', request);
      if (!response.success) {
        throw new Error(`Position close failed: ${response.errorMessage}`);
      }
      return response;
    } catch (error) {
      throw new Error(`Position close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getAuthToken(): string | null {
    return this.apiClient.getAuthToken();
  }

  isAuthenticated(): boolean {
    return this.apiClient.getAuthToken() !== null;
  }
}