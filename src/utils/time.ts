// src/utils/time.ts

export class TimeUtils {
  /** Return a Date that represents "now" as an absolute instant aligned to the target IANA zone. */
  static nowInZone(timeZone: string): Date {
    const now = new Date();
    // Create a "local-looking" time in the target zone, then compute the offset back to UTC
    const inv = new Date(now.toLocaleString('en-US', { timeZone }));
    const diff = now.getTime() - inv.getTime();
    return new Date(now.getTime() - diff);
  }

  /** Build an absolute Date for TODAY at HH:mm in the given IANA zone. */
  static todayAtInZone(hhmm: string, timeZone: string): Date {
    const [h, m] = hhmm.split(':').map(Number);
    const zNow = this.nowInZone(timeZone);
    const d = new Date(zNow);
    d.setHours(h, m ?? 0, 0, 0);
    return d;
  }

  /**
   * Default trading-hours check in New York (DST-safe).
   * Signature unchanged for existing call sites.
   */
  static isWithinTradingHours(startTime: string, endTime: string): boolean {
    return this.isWithinTradingHoursInTZ(startTime, endTime, 'America/New_York');
  }

  /**
   * General trading-hours check for any IANA timezone.
   * Handles same-day windows (e.g., 09:30–16:00) and wraps (e.g., 22:00–02:00).
   */
  static isWithinTradingHoursInTZ(startTime: string, endTime: string, timeZone: string): boolean {
    const nowZ   = this.nowInZone(timeZone);
    const startZ = this.todayAtInZone(startTime, timeZone);
    const endZ   = this.todayAtInZone(endTime,   timeZone);

    if (endZ >= startZ) {
      // normal same-day window
      return nowZ >= startZ && nowZ <= endZ;
    } else {
      // window that crosses midnight in the target TZ
      // e.g., 22:00–02:00 means (now >= 22:00 today) OR (now <= 02:00 today)
      return nowZ >= startZ || nowZ <= endZ;
    }
  }

  /**
   * Convenience: get warm-up/session anchors in NY time.
   * warmUpHours defaults to 2 unless you pass something else.
   */
  static getNYSessionAnchors(
    startTime: string,
    endTime: string,
    warmUpHours: number = 2
  ): { nyNow: Date; warmUpStart: Date; sessionStart: Date; sessionEnd: Date } {
    const TZ = 'America/New_York';
    const nyNow = this.nowInZone(TZ);
    const sessionStart = this.todayAtInZone(startTime, TZ);
    const sessionEnd   = this.todayAtInZone(endTime, TZ);

    const warmUpStart = new Date(sessionStart);
    warmUpStart.setHours(sessionStart.getHours() - warmUpHours, sessionStart.getMinutes(), 0, 0);

    return { nyNow, warmUpStart, sessionStart, sessionEnd };
  }
}
