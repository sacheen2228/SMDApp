const IST_OFFSET_MIN = 5 * 60 + 30;

/** Current time as an ISO-8601 string with the +05:30 (IST) offset. */
export function nowIst(): string {
  return toIst(new Date());
}

export function toIst(date: Date): string {
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
  const istMs = utcMs + IST_OFFSET_MIN * 60000;
  const ist = new Date(istMs);

  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const y = ist.getFullYear();
  const m = pad(ist.getMonth() + 1);
  const d = pad(ist.getDate());
  const hh = pad(ist.getHours());
  const mm = pad(ist.getMinutes());
  const ss = pad(ist.getSeconds());
  const ms = pad(ist.getMilliseconds(), 3);

  return `${y}-${m}-${d}T${hh}:${mm}:${ss}.${ms}+05:30`;
}

/** Infers the market session bucket from an IST ISO timestamp's clock time. */
export function inferMarketSession(istTimestamp: string): string {
  const match = istTimestamp.match(/T(\d{2}):(\d{2})/);
  if (!match) return "MORNING";
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  const minutesSinceMidnight = hh * 60 + mm;

  if (minutesSinceMidnight < 9 * 60) return "PRE_OPEN";
  if (minutesSinceMidnight < 9 * 60 + 30) return "OPENING";
  if (minutesSinceMidnight < 11 * 60 + 30) return "MORNING";
  if (minutesSinceMidnight < 13 * 60 + 30) return "MIDDAY";
  if (minutesSinceMidnight < 15 * 60) return "AFTERNOON";
  if (minutesSinceMidnight < 15 * 60 + 30) return "CLOSING";
  return "POST_CLOSE";
}

/** YYYY-MM-DD (IST) for a given IST ISO timestamp — used for "today's trades". */
export function istDatePart(istTimestamp: string): string {
  return istTimestamp.slice(0, 10);
}
