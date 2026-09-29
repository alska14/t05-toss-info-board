// 그래프·통계·시뮬레이터 전용 조회. 채점 대상 daily_readings/receipts에는 쓰지 않는다.
import { getMarketCache, setMarketCache } from "./db";

export interface MarketSnapshot {
  price: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  marketCap: number;
  sparkline7d: number[];
  sparkline7dTimes: number[]; // epoch ms, sparkline7d와 같은 길이
  sparklineIntervalLabel: string; // 예: "1시간 간격"
  updatedAt: string;
}

const FRESH_MS = 20_000;
const STALE_FALLBACK_MS = 5 * 60_000;

// 같은 서버리스 인스턴스가 재사용될 때만 먹는 1차 캐시. 인스턴스마다 따로 놀기 때문에
// 진짜 방어선은 DB 캐시(market_cache)다 — 여러 인스턴스·여러 탭이 하나의 캐시를 공유한다.
let memCache: { data: MarketSnapshot; expiresAt: number } | null = null;

function intervalLabel(times: number[]): string {
  if (times.length < 2) return "";
  const stepMs = times[times.length - 1] - times[times.length - 2];
  const mins = Math.round(stepMs / 60_000);
  if (mins <= 0) return "";
  if (mins < 60) return `${mins}분 간격`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}시간 간격`;
  return `${Math.round(hours / 24)}일 간격`;
}

function rowToSnapshot(row: {
  price: number;
  change_24h_pct: number;
  high_24h: number;
  low_24h: number;
  volume_24h: number;
  market_cap: number;
  sparkline_7d: number[] | { v: number[]; t: number[] };
  source_updated_at: string;
}): MarketSnapshot {
  const raw = row.sparkline_7d;
  const values = Array.isArray(raw) ? raw : raw.v;
  const times = Array.isArray(raw) ? approximateTimes(values.length) : raw.t;
  return {
    price: row.price,
    change24hPct: row.change_24h_pct,
    high24h: row.high_24h,
    low24h: row.low_24h,
    volume24h: row.volume_24h,
    marketCap: row.market_cap,
    sparkline7d: values,
    sparkline7dTimes: times,
    sparklineIntervalLabel: intervalLabel(times),
    updatedAt: row.source_updated_at,
  };
}

// 예전 캐시 행(순수 배열)에는 타임스탬프가 없다 — 7일 구간에 균등 분포한 것으로 근사한다.
function approximateTimes(len: number): number[] {
  if (len < 2) return len === 1 ? [Date.now()] : [];
  const now = Date.now();
  const spanMs = 7 * 24 * 60 * 60 * 1000;
  const step = spanMs / (len - 1);
  return Array.from({ length: len }, (_, i) => now - spanMs + i * step);
}

export async function fetchMarketSnapshot(): Promise<MarketSnapshot | null> {
  if (memCache && memCache.expiresAt > Date.now()) return memCache.data;

  let dbRow;
  try {
    dbRow = await getMarketCache();
  } catch {
    dbRow = null;
  }
  if (dbRow && Date.now() - new Date(dbRow.cached_at).getTime() < FRESH_MS) {
    const snapshot = rowToSnapshot(dbRow);
    memCache = { data: snapshot, expiresAt: Date.now() + FRESH_MS };
    return snapshot;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=krw&ids=bitcoin&sparkline=true&price_change_percentage=24h",
      { signal: controller.signal, cache: "no-store" }
    );
    clearTimeout(timer);
    if (!res.ok) {
      return fallbackSnapshot(dbRow);
    }
    const arr = (await res.json()) as Array<{
      current_price: number;
      price_change_percentage_24h: number;
      high_24h: number;
      low_24h: number;
      total_volume: number;
      market_cap: number;
      sparkline_in_7d?: { price: number[] };
      last_updated: string;
    }>;
    const coin = arr[0];
    if (!coin) return fallbackSnapshot(dbRow);

    // CoinGecko의 /coins/markets 응답은 vs_currency=krw로 요청해도 sparkline_in_7d만은
    // 항상 USD로 내려온다(CoinGecko API 자체의 특성). 그대로 쓰면 진입가·손절가 같은 KRW
    // 값과 스케일이 1000배 넘게 어긋나 차트에서 항상 "범위 밖"으로만 보인다. 근사 환산 대신
    // /market_chart?vs_currency=krw로 실제 KRW 7일 히스토리(+타임스탬프)를 따로 받아오고,
    // 실패 시에만(레이트리밋 등) USD sparkline을 현재가 비율로 근사 환산해 폴백한다.
    const { values: sparkline7d, times: sparkline7dTimes } = await fetchKrwSparkline(coin);

    const snapshot: MarketSnapshot = {
      price: coin.current_price,
      change24hPct: coin.price_change_percentage_24h ?? 0,
      high24h: coin.high_24h,
      low24h: coin.low_24h,
      volume24h: coin.total_volume,
      marketCap: coin.market_cap,
      sparkline7d,
      sparkline7dTimes,
      sparklineIntervalLabel: intervalLabel(sparkline7dTimes),
      updatedAt: coin.last_updated,
    };
    memCache = { data: snapshot, expiresAt: Date.now() + FRESH_MS };
    try {
      await setMarketCache({
        price: snapshot.price,
        change24hPct: snapshot.change24hPct,
        high24h: snapshot.high24h,
        low24h: snapshot.low24h,
        volume24h: snapshot.volume24h,
        marketCap: snapshot.marketCap,
        sparkline7d: snapshot.sparkline7d,
        sparkline7dTimes: snapshot.sparkline7dTimes,
        sourceUpdatedAt: snapshot.updatedAt,
      });
    } catch {
      // DB 캐시 기록 실패해도 방금 받은 값 자체는 정상 반환
    }
    return snapshot;
  } catch {
    clearTimeout(timer);
    return fallbackSnapshot(dbRow);
  }
}

async function fetchKrwSparkline(coin: {
  current_price: number;
  sparkline_in_7d?: { price: number[] };
}): Promise<{ values: number[]; times: number[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=krw&days=7",
      { signal: controller.signal, cache: "no-store" }
    );
    clearTimeout(timer);
    if (!res.ok) throw new Error(`market_chart ${res.status}`);
    const json = (await res.json()) as { prices?: [number, number][] };
    const pairs = json.prices ?? [];
    if (pairs.length >= 2) {
      return { values: pairs.map(([, v]) => v), times: pairs.map(([t]) => t) };
    }
    throw new Error("empty market_chart");
  } catch {
    clearTimeout(timer);
    // 폴백: USD sparkline을 현재 KRW가 비율로 근사 환산 (정확한 히스토리는 아니지만 모양은 유지됨)
    const rawSparkline = coin.sparkline_in_7d?.price ?? [];
    const lastUsd = rawSparkline[rawSparkline.length - 1];
    const krwPerUsd = lastUsd ? coin.current_price / lastUsd : 1;
    return {
      values: rawSparkline.map((v) => v * krwPerUsd),
      times: approximateTimes(rawSparkline.length),
    };
  }
}

function fallbackSnapshot(
  dbRow: Awaited<ReturnType<typeof getMarketCache>>
): MarketSnapshot | null {
  if (memCache) return memCache.data;
  if (dbRow && Date.now() - new Date(dbRow.cached_at).getTime() < STALE_FALLBACK_MS) {
    return rowToSnapshot(dbRow);
  }
  return null;
}
