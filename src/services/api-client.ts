import axios, { AxiosInstance, AxiosResponse } from 'axios';

export class ApiClient {
  private client: AxiosInstance;
  private authToken: string | null = null;

  constructor(baseURL: string) {
    this.client = axios.create({
      baseURL,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  setAuthToken(token: string): void {
    this.authToken = token;
  }

  getAuthToken(): string | null {
    return this.authToken;
  }

  async post<T>(url: string, data: any): Promise<T> {
    const response: AxiosResponse<T> = await this.client.post(url, data);
    return response.data;
  }

  async authPost<T>(url: string, data: any): Promise<T> {
    if (!this.authToken) {
      throw new Error('Not authenticated');
    }

    const response: AxiosResponse<T> = await this.client.post(url, data, {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });
    return response.data;
  }

  async get<T>(url: string): Promise<T> {
    const response: AxiosResponse<T> = await this.client.get(url);
    return response.data;
  }

  async authGet<T>(url: string): Promise<T> {
    if (!this.authToken) {
      throw new Error('Not authenticated');
    }

    const response: AxiosResponse<T> = await this.client.get(url, {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });
    return response.data;
  }
}