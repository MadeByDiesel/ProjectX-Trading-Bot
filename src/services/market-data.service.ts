import { ProjectXClient } from './projectx-client';
import { BarData } from '../types';
import { TimeUtils } from '../utils/time';
// line 4 (NEW)
type WarmupConfig = {
  tradingStartTime: string;
  tradingEndTime: string;
  // Strategy lookbacks (optional; used to size warm-up depth safely)
  atrPeriod?: number;
  deltaSmaPeriod?: number;
  breakoutLookback?: number;
  higherTimeframeWindow?: number;
};

export class MarketDataService {
  private client: ProjectXClient;

  constructor(client: ProjectXClient) {
    this.client = client;
  }

  /**
   * Calculates NY session times for a given date using config
   */
  private calculateNYSessionTimes(config: WarmupConfig, date: Date = new Date()):
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
  async fetchWarmUpData15min(contractId: string, config: WarmupConfig, date: Date = new Date()): Promise<BarData[]> {
    const { warmUpStart, sessionStart } = this.calculateNYSessionTimes(config, date);

    // Size history by the largest lookback + safety margin; ensure a reasonable floor for 15m TF
    const needs = [
      config.atrPeriod ?? 14,
      config.deltaSmaPeriod ?? 14,
      config.breakoutLookback ?? 20,
      config.higherTimeframeWindow ?? 5
    ];
    const minBars = Math.max(...needs) + 50;
    const limit = Math.max(minBars, 250);

    try {
      const bars = await this.client.getBars(contractId, '15', limit);

      // Prefer the intended warm-up window…
      const warmUpStartTime = warmUpStart.getTime();
      const sessionStartTime = sessionStart.getTime();
      const windowed = bars.filter(bar => {
        const t = new Date(bar.timestamp).getTime();
        return t >= warmUpStartTime && t <= sessionStartTime;
      });

      // …but if the window yields too few bars (e.g., already past session start), fall back to the last minBars
      if (windowed.length >= minBars) return windowed;
      return bars.slice(-minBars);
    } catch (error) {
      throw new Error(`Failed to fetch 15min warm-up data: ${error instanceof Error ? error.message : String(error)}`);
    }
  }


  /**
   * Fetches 3-minute bars for warm-up period using authenticated client
   */
  async fetchWarmUpData3min(contractId: string, config: WarmupConfig, date: Date = new Date()): Promise<BarData[]> {
    const { warmUpStart, sessionStart } = this.calculateNYSessionTimes(config, date);

    // Size history by largest lookback + margin; 3m needs a larger floor
    const needs = [
      config.atrPeriod ?? 14,
      config.deltaSmaPeriod ?? 14,
      config.breakoutLookback ?? 20,
      config.higherTimeframeWindow ?? 5
    ];
    const minBars = Math.max(...needs) + 50;
    const limit = Math.max(minBars, 500);

    try {
      const bars = await this.client.getBars(contractId, '3', limit);

      const warmUpStartTime = warmUpStart.getTime();
      const sessionStartTime = sessionStart.getTime();
      const windowed = bars.filter(bar => {
        const t = new Date(bar.timestamp).getTime();
        return t >= warmUpStartTime && t <= sessionStartTime;
      });

      if (windowed.length >= minBars) return windowed;
      return bars.slice(-minBars);
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
