import { neon } from "@neondatabase/serverless";
import { ErrorCode, NormalizedReading } from "./adapter";

const sql = neon(process.env.DATABASE_URL!);

let schemaReady: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS daily_readings (
          signal_id text NOT NULL,
          record_date date NOT NULL,
          normalized_value double precision NOT NULL,
          unit text NOT NULL,
          source_name text NOT NULL,
          source_url text NOT NULL,
          source_time timestamptz,
          record_timezone text NOT NULL,
          first_fetched_at timestamptz NOT NULL,
          last_fetched_at timestamptz NOT NULL,
          PRIMARY KEY (signal_id, record_date)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS reading_status (
          signal_id text PRIMARY KEY,
          freshness text NOT NULL,
          error_code text NOT NULL,
          last_run jsonb,
          sequence integer NOT NULL DEFAULT 0,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS sealed_receipts (
          signal_id text NOT NULL,
          record_date date NOT NULL,
          canonical_kind text NOT NULL DEFAULT 't04_day',
          server_created_at timestamptz NOT NULL DEFAULT now(),
          source_url text NOT NULL,
          source_observed_at timestamptz,
          normalized_value double precision NOT NULL,
          unit text NOT NULL,
          PRIMARY KEY (signal_id, record_date)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS sim_positions (
          id serial PRIMARY KEY,
          direction text NOT NULL CHECK (direction IN ('long', 'short')),
          leverage integer NOT NULL CHECK (leverage BETWEEN 1 AND 10),
          entry_price double precision NOT NULL,
          entry_at timestamptz NOT NULL DEFAULT now(),
          virtual_size double precision NOT NULL DEFAULT 1000000,
          status text NOT NULL DEFAULT 'open',
          close_price double precision,
          close_at timestamptz,
          close_reason text,
          rationale text,
          stop_loss_pct double precision
        )
      `;
      await sql`ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS stop_loss_pct double precision`;
      await sql`ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS entry_confidence double precision`;
      await sql`ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS exit_confidence double precision`;
      await sql`ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS exit_rationale text`;
      await sql`ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS opened_by text NOT NULL DEFAULT 'manual'`;
      await sql`ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS closed_by text`;
      await sql`ALTER TABLE sim_positions ADD COLUMN IF NOT EXISTS outcome_note text`;
      await sql`
        CREATE TABLE IF NOT EXISTS sim_decision_log (
          id serial PRIMARY KEY,
          created_at timestamptz NOT NULL DEFAULT now(),
          kind text NOT NULL,
          position_id integer,
          confidence double precision,
          rationale text,
          note text
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS sim_wallet (
          id integer PRIMARY KEY DEFAULT 1,
          balance double precision NOT NULL DEFAULT 10000000
        )
      `;
      await sql`INSERT INTO sim_wallet (id, balance) VALUES (1, 10000000) ON CONFLICT (id) DO NOTHING`;
      await sql`
        CREATE TABLE IF NOT EXISTS market_cache (
          id integer PRIMARY KEY DEFAULT 1,
          price double precision NOT NULL,
          change_24h_pct double precision NOT NULL,
          high_24h double precision NOT NULL,
          low_24h double precision NOT NULL,
          volume_24h double precision NOT NULL,
          market_cap double precision NOT NULL,
          sparkline_7d jsonb NOT NULL,
          source_updated_at text NOT NULL,
          cached_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS sim_settings (
          id integer PRIMARY KEY DEFAULT 1,
          auto_trading_enabled boolean NOT NULL DEFAULT false,
          max_allocation_pct integer NOT NULL DEFAULT 25,
          confidence_threshold integer NOT NULL DEFAULT 70,
          max_concurrent_positions integer NOT NULL DEFAULT 3,
          last_run_at timestamptz,
          last_run_summary text
        )
      `;
      await sql`ALTER TABLE sim_settings ADD COLUMN IF NOT EXISTS max_concurrent_positions integer NOT NULL DEFAULT 3`;
      await sql`INSERT INTO sim_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
    })();
  }
  return schemaReady;
}

export interface DailyRow {
  signal_id: string;
  record_date: string;
  normalized_value: number;
  unit: string;
  source_name: string;
  source_url: string;
  source_time: string | null;
  record_timezone: string;
  first_fetched_at: string;
  last_fetched_at: string;
}

export async function listDailyRows(signalId: string): Promise<DailyRow[]> {
  await ensureSchema();
  const rows = (await sql`
    SELECT signal_id, record_date::text, normalized_value, unit, source_name, source_url,
           source_time, record_timezone, first_fetched_at, last_fetched_at
    FROM daily_readings WHERE signal_id = ${signalId} ORDER BY record_date ASC
  `) as unknown as DailyRow[];
  return rows;
}

export async function getStatus(signalId: string) {
  await ensureSchema();
  const rows = (await sql`
    SELECT * FROM reading_status WHERE signal_id = ${signalId}
  `) as unknown as {
    signal_id: string;
    freshness: string;
    error_code: string;
    last_run: unknown;
    sequence: number;
    updated_at: string;
  }[];
  return rows[0] ?? null;
}

export async function applySuccessfulReading(
  reading: NormalizedReading,
  runMeta: { fixture_id?: string | null; virtual_now?: string | null }
) {
  await ensureSchema();

  const previousRows = (await sql`
    SELECT * FROM daily_readings
    WHERE signal_id = ${reading.signal_id} AND record_date < ${reading.record_date}
    ORDER BY record_date DESC
    LIMIT 1
  `) as unknown as DailyRow[];
  const previous = previousRows[0] ?? null;

  await sql`
    INSERT INTO daily_readings (
      signal_id, record_date, normalized_value, unit, source_name, source_url,
      source_time, record_timezone, first_fetched_at, last_fetched_at
    ) VALUES (
      ${reading.signal_id}, ${reading.record_date}, ${reading.normalized_value}, ${reading.unit},
      ${reading.source_name}, ${reading.source_url}, ${reading.source_time},
      ${reading.record_timezone}, ${reading.fetched_at}, ${reading.fetched_at}
    )
    ON CONFLICT (signal_id, record_date) DO UPDATE SET
      normalized_value = EXCLUDED.normalized_value,
      unit = EXCLUDED.unit,
      source_name = EXCLUDED.source_name,
      source_url = EXCLUDED.source_url,
      source_time = EXCLUDED.source_time,
      record_timezone = EXCLUDED.record_timezone,
      last_fetched_at = EXCLUDED.last_fetched_at
  `;

  await sql`
    INSERT INTO reading_status (signal_id, freshness, error_code, last_run, sequence, updated_at)
    VALUES (
      ${reading.signal_id}, 'fresh', 'none',
      ${JSON.stringify({
        fixture_id: runMeta.fixture_id ?? null,
        virtual_now: runMeta.virtual_now ?? reading.fetched_at,
        outcome: "success",
        error_code: "none",
        retry_after_seconds: null,
      })}::jsonb,
      1, now()
    )
    ON CONFLICT (signal_id) DO UPDATE SET
      freshness = 'fresh',
      error_code = 'none',
      last_run = EXCLUDED.last_run,
      sequence = reading_status.sequence + 1,
      updated_at = now()
  `;

  let delta: number | null = null;
  if (previous && previous.unit === reading.unit) {
    delta = reading.normalized_value - previous.normalized_value;
  }

  return { previous, delta };
}

export async function applyError(
  signalId: string,
  errorCode: ErrorCode,
  runMeta: { fixture_id?: string | null; virtual_now?: string | null; retry_after_seconds?: number | null }
) {
  await ensureSchema();
  await sql`
    INSERT INTO reading_status (signal_id, freshness, error_code, last_run, sequence, updated_at)
    VALUES (
      ${signalId}, 'stale', ${errorCode},
      ${JSON.stringify({
        fixture_id: runMeta.fixture_id ?? null,
        virtual_now: runMeta.virtual_now ?? null,
        outcome: "error",
        error_code: errorCode,
        retry_after_seconds: runMeta.retry_after_seconds ?? null,
      })}::jsonb,
      1, now()
    )
    ON CONFLICT (signal_id) DO UPDATE SET
      freshness = 'stale',
      error_code = ${errorCode},
      last_run = EXCLUDED.last_run,
      sequence = reading_status.sequence + 1,
      updated_at = now()
  `;
}

export async function sealReceipt(reading: NormalizedReading) {
  await ensureSchema();
  await sql`
    INSERT INTO sealed_receipts (
      signal_id, record_date, canonical_kind, source_url, source_observed_at, normalized_value, unit
    ) VALUES (
      ${reading.signal_id}, ${reading.record_date}, 't04_day',
      ${reading.source_url}, ${reading.source_time}, ${reading.normalized_value}, ${reading.unit}
    )
    ON CONFLICT (signal_id, record_date) DO UPDATE SET
      source_url = EXCLUDED.source_url,
      source_observed_at = EXCLUDED.source_observed_at,
      normalized_value = EXCLUDED.normalized_value,
      unit = EXCLUDED.unit
  `;
}

export async function listReceipts(signalId: string) {
  await ensureSchema();
  const rows = (await sql`
    SELECT signal_id, record_date::text, canonical_kind, server_created_at, source_url,
           source_observed_at, normalized_value, unit
    FROM sealed_receipts WHERE signal_id = ${signalId} ORDER BY server_created_at ASC
  `) as unknown as {
    signal_id: string;
    record_date: string;
    canonical_kind: string;
    server_created_at: string;
    source_url: string;
    source_observed_at: string | null;
    normalized_value: number;
    unit: string;
  }[];
  return rows;
}

export async function resetSignal(signalId: string) {
  await ensureSchema();
  await sql`DELETE FROM daily_readings WHERE signal_id = ${signalId}`;
  await sql`DELETE FROM reading_status WHERE signal_id = ${signalId}`;
  await sql`DELETE FROM sealed_receipts WHERE signal_id = ${signalId}`;
}

// 실전 자동매매를 켜기 전, 테스트 중 쌓인 포지션·로그·잔고를 깨끗이 지운다.
// 라이브 정보판(daily_readings 등)이나 T04 채점 데모(fixture replay) 상태는 건드리지 않는다.
export async function resetSimData(): Promise<void> {
  await ensureSchema();
  await sql`DELETE FROM sim_positions`;
  await sql`DELETE FROM sim_decision_log`;
  await sql`UPDATE sim_wallet SET balance = 10000000 WHERE id = 1`;
  await sql`UPDATE sim_settings SET last_run_at = NULL, last_run_summary = NULL WHERE id = 1`;
}

export interface SimPosition {
  id: number;
  direction: "long" | "short";
  leverage: number;
  entry_price: number;
  entry_at: string;
  virtual_size: number;
  status: "open" | "closed" | "liquidated";
  close_price: number | null;
  close_at: string | null;
  close_reason: string | null;
  rationale: string | null;
  stop_loss_pct: number | null;
  entry_confidence: number | null;
  exit_confidence: number | null;
  exit_rationale: string | null;
  opened_by: "manual" | "ai_auto";
  closed_by: "manual" | "ai_auto" | "stop_loss" | "liquidation" | null;
  outcome_note: string | null;
}

export interface SimSettings {
  auto_trading_enabled: boolean;
  max_allocation_pct: number;
  confidence_threshold: number;
  max_concurrent_positions: number;
  last_run_at: string | null;
  last_run_summary: string | null;
}

export async function getSimSettings(): Promise<SimSettings> {
  await ensureSchema();
  const rows = (await sql`SELECT * FROM sim_settings WHERE id = 1`) as unknown as SimSettings[];
  return rows[0];
}

export async function updateSimSettings(patch: {
  auto_trading_enabled?: boolean;
  max_allocation_pct?: number;
  confidence_threshold?: number;
  max_concurrent_positions?: number;
}): Promise<SimSettings> {
  await ensureSchema();
  const current = await getSimSettings();
  const merged = { ...current, ...patch };
  const rows = (await sql`
    UPDATE sim_settings
    SET auto_trading_enabled = ${merged.auto_trading_enabled},
        max_allocation_pct = ${merged.max_allocation_pct},
        confidence_threshold = ${merged.confidence_threshold},
        max_concurrent_positions = ${merged.max_concurrent_positions}
    WHERE id = 1
    RETURNING *
  `) as unknown as SimSettings[];
  return rows[0];
}

export async function recordAutoRun(summary: string): Promise<void> {
  await ensureSchema();
  await sql`UPDATE sim_settings SET last_run_at = now(), last_run_summary = ${summary} WHERE id = 1`;
}

export async function listOpenPositions(): Promise<SimPosition[]> {
  await ensureSchema();
  const rows = (await sql`
    SELECT * FROM sim_positions WHERE status = 'open' ORDER BY entry_at DESC
  `) as unknown as SimPosition[];
  return rows;
}

export async function listPositionHistory(limit = 20): Promise<SimPosition[]> {
  await ensureSchema();
  const rows = (await sql`
    SELECT * FROM sim_positions WHERE status != 'open' ORDER BY close_at DESC LIMIT ${limit}
  `) as unknown as SimPosition[];
  return rows;
}

export async function getWalletBalance(): Promise<number> {
  await ensureSchema();
  const rows = (await sql`SELECT balance FROM sim_wallet WHERE id = 1`) as unknown as { balance: number }[];
  return rows[0]?.balance ?? 0;
}

export interface MarketCacheRow {
  price: number;
  change_24h_pct: number;
  high_24h: number;
  low_24h: number;
  volume_24h: number;
  market_cap: number;
  sparkline_7d: number[];
  source_updated_at: string;
  cached_at: string;
}

// CoinGecko 무료 API의 호출 제한(429)을 피하려고 서버 인스턴스 전체가 공유하는
// DB 캐시. 인메모리 캐시는 서버리스 인스턴스마다 따로 놀아서 효과가 없었다.
export async function getMarketCache(): Promise<MarketCacheRow | null> {
  await ensureSchema();
  const rows = (await sql`SELECT * FROM market_cache WHERE id = 1`) as unknown as MarketCacheRow[];
  return rows[0] ?? null;
}

export async function setMarketCache(data: {
  price: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  marketCap: number;
  sparkline7d: number[];
  sourceUpdatedAt: string;
}): Promise<void> {
  await ensureSchema();
  await sql`
    INSERT INTO market_cache (
      id, price, change_24h_pct, high_24h, low_24h, volume_24h, market_cap, sparkline_7d, source_updated_at, cached_at
    ) VALUES (
      1, ${data.price}, ${data.change24hPct}, ${data.high24h}, ${data.low24h}, ${data.volume24h}, ${data.marketCap},
      ${JSON.stringify(data.sparkline7d)}, ${data.sourceUpdatedAt}, now()
    )
    ON CONFLICT (id) DO UPDATE SET
      price = EXCLUDED.price,
      change_24h_pct = EXCLUDED.change_24h_pct,
      high_24h = EXCLUDED.high_24h,
      low_24h = EXCLUDED.low_24h,
      volume_24h = EXCLUDED.volume_24h,
      market_cap = EXCLUDED.market_cap,
      sparkline_7d = EXCLUDED.sparkline_7d,
      source_updated_at = EXCLUDED.source_updated_at,
      cached_at = now()
  `;
}

export async function openPosition(
  direction: "long" | "short",
  leverage: number,
  entryPrice: number,
  rationale: string | null,
  virtualSize: number,
  stopLossPct: number | null,
  entryConfidence: number | null = null,
  openedBy: "manual" | "ai_auto" = "manual"
): Promise<SimPosition> {
  await ensureSchema();
  const rows = (await sql`
    INSERT INTO sim_positions (
      direction, leverage, entry_price, rationale, virtual_size, stop_loss_pct, entry_confidence, opened_by
    )
    VALUES (${direction}, ${leverage}, ${entryPrice}, ${rationale}, ${virtualSize}, ${stopLossPct}, ${entryConfidence}, ${openedBy})
    RETURNING *
  `) as unknown as SimPosition[];
  await sql`UPDATE sim_wallet SET balance = balance - ${virtualSize} WHERE id = 1`;
  return rows[0];
}

export async function closePosition(
  id: number,
  closePrice: number,
  reason: "manual" | "liquidation" | "stop_loss" | "ai_auto",
  returnAmount: number,
  exitConfidence: number | null = null,
  exitRationale: string | null = null,
  outcomeNote: string | null = null
): Promise<void> {
  await ensureSchema();
  await sql`
    UPDATE sim_positions
    SET status = ${reason === "manual" || reason === "ai_auto" ? "closed" : "liquidated"},
        close_price = ${closePrice},
        close_at = now(),
        close_reason = ${reason},
        closed_by = ${reason},
        exit_confidence = ${exitConfidence},
        exit_rationale = ${exitRationale},
        outcome_note = ${outcomeNote}
    WHERE id = ${id} AND status = 'open'
  `;
  await sql`UPDATE sim_wallet SET balance = balance + ${returnAmount} WHERE id = 1`;
}

export interface DecisionLogRow {
  id: number;
  created_at: string;
  kind: string;
  position_id: number | null;
  confidence: number | null;
  rationale: string | null;
  note: string | null;
}

export async function logDecision(entry: {
  kind: string;
  positionId?: number | null;
  confidence?: number | null;
  rationale?: string | null;
  note?: string | null;
}): Promise<void> {
  await ensureSchema();
  await sql`
    INSERT INTO sim_decision_log (kind, position_id, confidence, rationale, note)
    VALUES (${entry.kind}, ${entry.positionId ?? null}, ${entry.confidence ?? null}, ${entry.rationale ?? null}, ${entry.note ?? null})
  `;
}

export async function listDecisionLog(limit = 30): Promise<DecisionLogRow[]> {
  await ensureSchema();
  const rows = (await sql`
    SELECT * FROM sim_decision_log ORDER BY created_at DESC LIMIT ${limit}
  `) as unknown as DecisionLogRow[];
  return rows;
}

// 최근 청산 결과를 요약해 다음 AI 호출의 프롬프트에 "지난 성과 피드백"으로 끼워 넣는다.
// 모델 가중치를 다시 학습시키는 것이 아니라, 매 호출마다 최근 승률·신뢰도 구간별 성적을
// 문맥으로 알려줘서 스스로 보정하게 하는 인컨텍스트 방식이다.
export async function getRecentPerformanceSummary(limit = 15): Promise<string> {
  await ensureSchema();
  const rows = (await sql`
    SELECT direction, entry_confidence, virtual_size, entry_price, close_price, leverage, closed_by, outcome_note
    FROM sim_positions
    WHERE status != 'open' AND close_price IS NOT NULL
    ORDER BY close_at DESC
    LIMIT ${limit}
  `) as unknown as {
    direction: "long" | "short";
    entry_confidence: number | null;
    virtual_size: number;
    entry_price: number;
    close_price: number;
    leverage: number;
    closed_by: string | null;
    outcome_note: string | null;
  }[];

  if (rows.length === 0) return "최근 거래 이력 없음.";

  let wins = 0;
  let highConfWins = 0;
  let highConfTotal = 0;
  let lowConfWins = 0;
  let lowConfTotal = 0;
  const recentLosses: string[] = [];

  for (const r of rows) {
    const raw = r.direction === "long" ? (r.close_price - r.entry_price) / r.entry_price : (r.entry_price - r.close_price) / r.entry_price;
    const win = raw > 0;
    if (win) wins += 1;
    if (r.entry_confidence != null) {
      if (r.entry_confidence >= 70) {
        highConfTotal += 1;
        if (win) highConfWins += 1;
      } else {
        lowConfTotal += 1;
        if (win) lowConfWins += 1;
      }
    }
    if (!win && recentLosses.length < 3 && r.outcome_note) {
      recentLosses.push(r.outcome_note);
    }
  }

  const winRate = ((wins / rows.length) * 100).toFixed(0);
  const parts = [`최근 ${rows.length}건 중 ${wins}승, 승률 ${winRate}%.`];
  if (highConfTotal > 0) {
    parts.push(`신뢰도 70 이상 추천 ${highConfTotal}건 중 ${highConfWins}승(${((highConfWins / highConfTotal) * 100).toFixed(0)}%).`);
  }
  if (lowConfTotal > 0) {
    parts.push(`신뢰도 70 미만 추천 ${lowConfTotal}건 중 ${lowConfWins}승(${((lowConfWins / lowConfTotal) * 100).toFixed(0)}%).`);
  }
  if (recentLosses.length) {
    parts.push(`최근 손실 원인: ${recentLosses.join(" / ")}`);
  }
  return parts.join(" ");
}
