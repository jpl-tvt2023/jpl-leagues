/**
 * The current date and hour in IST.
 *
 * Import-free so the unit lane can exercise it without a database — the daily runner's whole
 * scheduling decision rests on this one function, and it is the piece most worth pinning down.
 *
 * Via `Intl` rather than a hardcoded +5:30 offset: the offset becomes the platform's business
 * rather than a constant to get wrong. India has never observed DST, so the two agree today —
 * but "correct by construction" and "correct by coincidence" age differently.
 *
 * "en-CA" because it formats dates as YYYY-MM-DD, which sorts lexicographically and reads as a
 * stable cache key.
 */
export function istNow(now: Date = new Date()): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const find = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // Some ICU versions render midnight as hour "24"; normalise so 00:xx is 0, not 24.
  const hour = Number(find("hour")) % 24;
  return { date: `${find("year")}-${find("month")}-${find("day")}`, hour };
}
