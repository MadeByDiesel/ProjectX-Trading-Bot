import { ProjectXClient } from './projectx-client';
import { BarData } from '../types';
import { TimeUtils } from '../utils/time';

export class MarketDataService {
  private client: ProjectXClient;

  constructor(client: ProjectXClient) {
    this.client = client;
  }

  /**
   * Calculates NY session times for a given date using config
   */
  private calculateNYSessionTimes(config: { tradingStartTime: string; tradingEndTime: string }, date: Date = new Date()): 
    { warmUpStart: Date; sessionStart: Date; sessionEnd: Date } {
    
    // Parse config times
    const [startHour, startMinute] = config.tradingStartTime.split(':').map(Number);
    const [endHour, endMinute] = config.tradingEndTime.split(':').map(Number);
    
    const sessionStart = new Date(date);
    sessionStart.setHours(startHour, startMinute, 0, 0);
    
    const sessionEnd = new Date(date);
    sessionEnd.setHours(endHour, endMinute, 0, 0);
    
    // Warm-up: 4 hours before session start
    const warmUpStart = new Date(sessionStart);
    warmUpStart.setHours(sessionStart.getHours() - 4);
    
    return { warmUpStart, sessionStart, sessionEnd };
  }

  /**
   * Fetches 15-minute bars for warm-up period using authenticated client
   */
  async fetchWarmUpData15min(contractId: string, config: { tradingStartTime: string; tradingEndTime: string }, date: Date = new Date()): Promise<BarData[]> {
    const { warmUpStart, sessionStart } = this.calculateNYSessionTimes(config, date);
    
    try {
      // Use the authenticated client to fetch bars - it will handle the time range internally
      const bars = await this.client.getBars(contractId, '15', 100);
      
      // Filter bars to only include the warm-up period
      const warmUpStartTime = warmUpStart.getTime();
      const sessionStartTime = sessionStart.getTime();
      
      return bars.filter(bar => {
        const barTime = new Date(bar.timestamp).getTime();
        return barTime >= warmUpStartTime && barTime <= sessionStartTime;
      });
    } catch (error) {
      throw new Error(`Failed to fetch 15min warm-up data: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Fetches 3-minute bars for warm-up period using authenticated client
   */
  async fetchWarmUpData3min(contractId: string, config: { tradingStartTime: string; tradingEndTime: string }, date: Date = new Date()): Promise<BarData[]> {
    const { warmUpStart, sessionStart } = this.calculateNYSessionTimes(config, date);
    
    try {
      // Use the authenticated client to fetch bars
      const bars = await this.client.getBars(contractId, '3', 100);
      
      // Filter bars to only include the warm-up period
      const warmUpStartTime = warmUpStart.getTime();
      const sessionStartTime = sessionStart.getTime();
      
      return bars.filter(bar => {
        const barTime = new Date(bar.timestamp).getTime();
        return barTime >= warmUpStartTime && barTime <= sessionStartTime;
      });
    } catch (error) {
      throw new Error(`Failed to fetch 3min warm-up data: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Validates warm-up data is sufficient for strategy
   */
  validateWarmUpData(bars: BarData[], timeframe: string): boolean {
    const minBarsRequired = timeframe === '15min' ? 16 : 80; // 4 hours of data
    return bars.length >= minBarsRequired;
  }

  /**
   * Checks if current time is within trading hours using your TimeUtils
   */
  isWithinTradingHours(tradingStartTime: string, tradingEndTime: string): boolean {
    return TimeUtils.isWithinTradingHours(tradingStartTime, tradingEndTime);
  }
}
