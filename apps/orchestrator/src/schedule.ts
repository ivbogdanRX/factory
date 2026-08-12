export const PT = "America/Los_Angeles";

/**
 * Convert a local date+time in an IANA timezone to an ISO-8601 UTC string.
 * Ported from ads-uploader src/lib/targeting.ts (zonedDateTimeToUtcIso).
 */
export function zonedDateTimeToUtcIso(date: string, time: string, timeZone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (![year, month, day, hour, minute].every((n) => Number.isFinite(n))) {
    throw new Error(`Invalid date/time: ${date} ${time}`);
  }

  // Guess UTC as if the wall clock were UTC, then correct by the zone offset.
  let utcMs = Date.UTC(year!, month! - 1, day!, hour!, minute!, 0);
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(utcMs));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    let h = get("hour");
    if (h === 24) h = 0;
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), h, get("minute"), get("second") || 0);
    const desired = Date.UTC(year!, month! - 1, day!, hour!, minute!, 0);
    utcMs += desired - asUtc;
  }
  return new Date(utcMs).toISOString();
}

/** Today's date (YYYY-MM-DD) in the given IANA timezone. */
export function todayInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Current hour + minute in the given timezone. */
export function nowClockInTimeZone(timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0;
  return { hour, minute: get("minute") };
}

/** ISO UTC instant for tomorrow (PT calendar) at the given PT hour. */
export function nextDayStartIso(startHourPt: number): string {
  const today = todayInTimeZone(PT);
  const [y, m, d] = today.split("-").map(Number);
  // Add one calendar day via UTC date math on the Y-M-D triple.
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
  const nextDate = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
  const hh = String(Math.max(0, Math.min(23, startHourPt))).padStart(2, "0");
  return zonedDateTimeToUtcIso(nextDate, `${hh}:00`, PT);
}

/** Next occurrence of the daily run hour (PT) as an ISO UTC instant. */
export function nextRunAtIso(runHourPt: number): string {
  const today = todayInTimeZone(PT);
  const hh = String(Math.max(0, Math.min(23, runHourPt))).padStart(2, "0");
  const todayRun = zonedDateTimeToUtcIso(today, `${hh}:00`, PT);
  if (new Date(todayRun).getTime() > Date.now()) return todayRun;
  const [y, m, d] = today.split("-").map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
  const nextDate = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
  return zonedDateTimeToUtcIso(nextDate, `${hh}:00`, PT);
}
