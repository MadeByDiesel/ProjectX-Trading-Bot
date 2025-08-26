export class TimeUtils {
  /** Return a Date that represents "now" as an absolute instant aligned to the target IANA zone. */
  static nowInZone(timeZone: string): Date {
    const now = new Date();
    const inv = new Date(now.toLocaleString('en-US', { timeZone }));
    const diff = now.getTime() - inv.getTime();
    return new Date(now.getTime() + diff);
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
   * NY-session check. Same signature as before to preserve call sites,
   * but evaluates in America/New_York (DST-safe).
   */
  static isWithinTradingHours(startTime: string, endTime: string): boolean {
    const TZ = 'America/New_York';
    const zNow = this.nowInZone(TZ);
    const start = this.todayAtInZone(startTime, TZ);
    const end   = this.todayAtInZone(endTime, TZ);
    return zNow >= start && zNow <= end;
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
