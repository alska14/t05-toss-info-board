// ALEPH T04 정규화 어댑터. adapter-reset.example.js와 같은 규칙을 DB 저장 버전으로 옮김.

export const NORMALIZED_KEYS = [
  "signal_id",
  "normalized_value",
  "unit",
  "source_name",
  "source_url",
  "source_time",
  "fetched_at",
  "record_timezone",
  "record_date",
] as const;

export const ERROR_CODES = [
  "timeout",
  "auth",
  "rate_limit",
  "offline",
  "schema_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface NormalizedReading {
  signal_id: string;
  normalized_value: number;
  unit: string;
  source_name: string;
  source_url: string;
  source_time: string | null;
  fetched_at: string;
  record_timezone: "Asia/Seoul";
  record_date: string;
}

export function kstDate(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("fetched_at must be a valid ISO-8601 date-time");
  }
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function validateNormalizedReading(reading: unknown): reading is NormalizedReading {
  if (!reading || typeof reading !== "object" || Array.isArray(reading)) {
    throw new TypeError("normalized reading must be an object");
  }
  const r = reading as Record<string, unknown>;
  const actualKeys = Object.keys(r).sort();
  const expectedKeys = [...NORMALIZED_KEYS].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((k, i) => k !== expectedKeys[i])
  ) {
    throw new TypeError(`normalized reading keys must be exactly: ${NORMALIZED_KEYS.join(", ")}`);
  }
  if (typeof r.signal_id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(r.signal_id) || r.signal_id.length > 100) {
    throw new TypeError("signal_id is invalid");
  }
  if (typeof r.normalized_value !== "number" || !Number.isFinite(r.normalized_value)) {
    throw new TypeError("normalized_value must be a finite number");
  }
  for (const field of ["unit", "source_name"] as const) {
    if (typeof r[field] !== "string" || (r[field] as string).trim() === "") {
      throw new TypeError(`${field} must be a non-empty string`);
    }
  }
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(r.source_url as string);
  } catch {
    throw new TypeError("source_url must be an absolute URL");
  }
  if (sourceUrl.protocol !== "https:") {
    throw new TypeError("source_url must use HTTPS");
  }
  if (r.source_time !== null && Number.isNaN(new Date(r.source_time as string).getTime())) {
    throw new TypeError("source_time must be a valid date-time or null");
  }
  if (Number.isNaN(new Date(r.fetched_at as string).getTime())) {
    throw new TypeError("fetched_at must be a valid date-time");
  }
  if (r.record_timezone !== "Asia/Seoul") {
    throw new TypeError("record_timezone must be Asia/Seoul");
  }
  if (
    typeof r.record_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(r.record_date) ||
    r.record_date !== kstDate(r.fetched_at as string)
  ) {
    throw new TypeError("record_date must be the Asia/Seoul date derived from fetched_at");
  }
  return true;
}
