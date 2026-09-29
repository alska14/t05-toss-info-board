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
  updatedAt: string;
}

const FRESH_MS = 20_000;
const STALE_FALLBACK_MS = 5 * 60_000;

// 같은 서버리스 인스턴스가 재사용될 때만 먹는 1차 캐시. 인스턴스마다 따로 놀기 때문에
// 진짜 방어선은 DB 캐시(market_cache)다 — 여러 인스턴스·여러 탭이 하나의 캐시를 공유한다.
let memCache: { data: MarketSnapshot; expiresAt: number } | null = null;

function rowToSnapshot(row: {
  price: number;
  change_24h_pct: number;
  high_24h: number;
  low_24h: number;
  volume_24h: number;
  market_cap: number;
  sparkline_7d: number[];
  source_updated_at: string;
}): MarketSnapshot {
  return {
    price: row.price,
    change24hPct: row.change_24h_pct,
    high24h: row.high_24h,
    low24h: row.low_24h,
    volume24h: row.volume_24h,
    marketCap: row.market_cap,
    sparkline7d: row.sparkline_7d,
    updatedAt: row.source_updated_at,
  };
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

    const snapshot: MarketSnapshot = {
      price: coin.current_price,
      change24hPct: coin.price_change_percentage_24h ?? 0,
      high24h: coin.high_24h,
      low24h: coin.low_24h,
      volume24h: coin.total_volume,
      marketCap: coin.market_cap,
      sparkline7d: coin.sparkline_in_7d?.price ?? [],
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

function fallbackSnapshot(
  dbRow: Awaited<ReturnType<typeof getMarketCache>>
): MarketSnapshot | null {
  if (memCache) return memCache.data;
  if (dbRow && Date.now() - new Date(dbRow.cached_at).getTime() < STALE_FALLBACK_MS) {
    return rowToSnapshot(dbRow);
  }
  return null;
}
