import { NextResponse } from "next/server";
import { ErrorCode, kstDate, NormalizedReading, validateNormalizedReading } from "@/lib/adapter";
import { applyError, applySuccessfulReading, getStatus, listDailyRows, sealReceipt } from "@/lib/db";
import { LIVE_SIGNAL_ID, LIVE_SOURCE_NAME, LIVE_SOURCE_URL } from "@/lib/signal";

export const dynamic = "force-dynamic";

async function fetchLive(): Promise<{ reading?: NormalizedReading; error?: ErrorCode }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  let res: Response;
  try {
    res = await fetch(LIVE_SOURCE_URL, { signal: controller.signal, cache: "no-store" });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") return { error: "timeout" };
    return { error: "offline" };
  }
  clearTimeout(timer);

  if (res.status === 401 || res.status === 403) return { error: "auth" };
  if (res.status === 429) return { error: "rate_limit" };
  if (!res.ok) return { error: "schema_error" };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { error: "schema_error" };
  }

  const b = body as { bitcoin?: { krw?: number; last_updated_at?: number } };
  const value = b?.bitcoin?.krw;
  const updatedAtSec = b?.bitcoin?.last_updated_at;
  if (typeof value !== "number" || typeof updatedAtSec !== "number") {
    return { error: "schema_error" };
  }

  const fetchedAt = new Date().toISOString();
  const sourceTime = new Date(updatedAtSec * 1000).toISOString();
  const reading: NormalizedReading = {
    signal_id: LIVE_SIGNAL_ID,
    normalized_value: value,
    unit: "KRW",
    source_name: LIVE_SOURCE_NAME,
    source_url: "https://www.coingecko.com/en/coins/bitcoin/krw",
    source_time: sourceTime,
    fetched_at: fetchedAt,
    record_timezone: "Asia/Seoul",
    record_date: kstDate(fetchedAt),
  };

  try {
    validateNormalizedReading(reading);
  } catch {
    return { error: "schema_error" };
  }

  return { reading };
}

async function currentState() {
  const [rows, status] = await Promise.all([listDailyRows(LIVE_SIGNAL_ID), getStatus(LIVE_SIGNAL_ID)]);
  return { rows, status };
}

export async function GET() {
  const result = await fetchLive();

  if (result.reading) {
    const { previous, delta } = await applySuccessfulReading(result.reading, {
      fixture_id: null,
      virtual_now: result.reading.fetched_at,
    });
    await sealReceipt(result.reading);
    const state = await currentState();
    return NextResponse.json({ ok: true, delta, previous, current: result.reading, ...state });
  }

  await applyError(LIVE_SIGNAL_ID, result.error!, { fixture_id: null, virtual_now: new Date().toISOString() });
  const state = await currentState();
  return NextResponse.json({ ok: false, error_code: result.error, ...state });
}
