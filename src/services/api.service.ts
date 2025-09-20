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
    type: number;      // your enum (1=Market, 2=Limit, etc.)
    side: number;      // ✅ Topstep expects 0=Bid(Buy), 1=Ask(Sell)
    size: number;
    limitPrice?: number;
    stopPrice?: number;
    trailPrice?: number;
    linkedOrderId?: number;
  }): Promise<OrderPlaceResponse> {
    // ---- Normalize & validate ----
    const body = { ...request };


    if (body.side !== 0 && body.side !== 1) {
      throw new Error(`Order placement failed: side must be 0 (Buy) or 1 (Sell), got ${body.side}`);
    }

    // Ensure numeric size
    body.size = Math.max(1, Math.floor(Number(body.size) || 0));

    // WITH this (Topstep enums: 1=Limit, 2=Market, 4=Stop, 5=TrailingStop, 6=JoinBid, 7=JoinAsk):
    if (![1, 2, 4, 5, 6, 7].includes(body.type)) {
      throw new Error(`Order placement failed: unsupported type enum ${body.type}`);
    }

    // Trace (no secrets)
    console.log('[order->broker]', {
      accountId: body.accountId,
      contractId: body.contractId,
      type: body.type,
      side: body.side,
      size: body.size,
      limitPrice: body.limitPrice,
      stopPrice: body.stopPrice,
    });

    try {
      const res = await this.apiClient.authPost<OrderPlaceResponse>('/api/Order/place', body);
      if (!res.success) throw new Error(res.errorMessage || 'Unknown broker error');
      return res;
    } catch (err: any) {
      const msg = (err?.response?.data ?? err?.message ?? '').toString();
      console.error('[order<-broker][error]', err?.response?.status ?? '', msg);
      throw new Error(`Order placement failed: ${msg}`);
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

    async partialClosePosition(request: { accountId: number; contractId: string; size: number }): Promise<ApiResponseBase> {
    try {
      const response = await this.apiClient.authPost<ApiResponseBase>('/api/Position/partialCloseContract', request);
      if (!response.success) {
        throw new Error(`Partial position close failed: ${response.errorMessage}`);
      }
      return response;
    } catch (error) {
      throw new Error(`Partial position close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getAuthToken(): string | null {
    return this.apiClient.getAuthToken();
  }

  isAuthenticated(): boolean {
    return this.apiClient.getAuthToken() !== null;
  }
}