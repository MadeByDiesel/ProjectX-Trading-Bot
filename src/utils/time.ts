export class TimeUtils {
  static isWithinTradingHours(startTime: string, endTime: string): boolean {
    // Simple implementation - will refine later
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentTime = hours * 100 + minutes;
    
    const [startHour, startMinute] = startTime.split(':').map(Number);
    const [endHour, endMinute] = endTime.split(':').map(Number);
    
    return currentTime >= (startHour * 100 + startMinute) && 
           currentTime <= (endHour * 100 + endMinute);
  }
}