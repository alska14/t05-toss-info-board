"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Row = {
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
};

type Status = {
  freshness: "fresh" | "stale";
  error_code: string;
  last_run: {
    fixture_id: string | null;
    virtual_now: string | null;
    outcome: string;
    error_code: string;
    retry_after_seconds: number | null;
  } | null;
  sequence: number;
} | null;

type ReadingResponse = {
  ok: boolean;
  error_code?: string;
  delta?: number | null;
  current?: Row;
  rows: Row[];
  status: Status;
};

type Stats = {
  price: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  marketCap: number;
  sparkline7d: number[];
  sparkline7dTimes: number[];
  sparklineIntervalLabel: string;
  updatedAt: string;
};

type NewsItem = { title: string; link: string; source: string; pubDate: string };

type SimPosition = {
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
  outcome_note: string | null;
  opened_by: "manual" | "ai_auto";
  closed_by: "manual" | "ai_auto" | "stop_loss" | "liquidation" | null;
  current_price?: number;
  liquidation_price?: number;
  pnl_pct?: number;
  pnl_amount?: number;
};

type Wallet = { available: number; locked: number; total: number };

type AdviceOption = {
  direction: "long" | "short";
  leverage: number;
  pct: number;
  stopLossPct: number;
  confidence: number;
  rationale: string;
};

type SimSettings = {
  auto_trading_enabled: boolean;
  max_allocation_pct: number;
  confidence_threshold: number;
  max_concurrent_positions: number;
  last_run_at: string | null;
  last_run_summary: string | null;
};

type DecisionLogRow = {
  id: number;
  created_at: string;
  kind: string;
  position_id: number | null;
  confidence: number | null;
  rationale: string | null;
  note: string | null;
};

const ERROR_LABEL: Record<string, string> = {
  none: "정상",
  timeout: "응답 지연(타임아웃)",
  auth: "인증 거절(401/403)",
  rate_limit: "호출 제한(429)",
  offline: "오프라인",
  schema_error: "응답 형식 오류",
};

const FIXTURE_BUTTONS: { id: string; label: string; kind: "success" | "failure" | "recover" }[] = [
  { id: "T04-NORMAL-D1-A", label: "1일차 조회 (D1-A)", kind: "success" },
  { id: "T04-NORMAL-D1-B", label: "1일차 재조회 (D1-B, 같은 날)", kind: "success" },
  { id: "T04-NORMAL-D2", label: "2일차 조회 (D2)", kind: "success" },
  { id: "T04-TIMEOUT", label: "느린 응답(타임아웃)", kind: "failure" },
  { id: "T04-AUTH-401", label: "외부 원천 401 거절", kind: "failure" },
  { id: "T04-RATE-429", label: "외부 원천 호출 제한", kind: "failure" },
  { id: "T04-OFFLINE", label: "오프라인", kind: "failure" },
  { id: "T04-SCHEMA-BREAK", label: "응답 형식 변경", kind: "failure" },
  { id: "T04-RECOVER-D2", label: "다시 시도 → 회복(RECOVER-D2)", kind: "recover" },
];

const LEVERAGE_CHOICES = [1, 2, 3, 5, 10];

const TABS = [
  { id: "live", label: "① 정보판" },
  { id: "chart", label: "② 차트·통계" },
  { id: "news", label: "③ 뉴스" },
  { id: "auto", label: "④ 자동매매" },
  { id: "manual", label: "⑤ 수동 거래" },
  { id: "demo", label: "⑥ 채점 데모" },
] as const;

const DECISION_KIND_LABEL: Record<string, string> = {
  entry: "AI 진입",
  entry_skip: "AI 진입 보류",
  exit: "AI 매도",
  exit_skip: "AI 매도 보류",
  liquidation: "강제 청산",
  stop_loss: "손절",
  manual_close: "수동 종료",
};

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function fmtKrw(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toLocaleString("ko-KR");
}

function closedPnlAmount(h: SimPosition): number | null {
  if (h.close_price == null) return null;
  const raw =
    h.direction === "long"
      ? (h.close_price - h.entry_price) / h.entry_price
      : (h.entry_price - h.close_price) / h.entry_price;
  return h.virtual_size * raw * h.leverage;
}

function StatusBadge({ status }: { status: Status }) {
  if (!status) {
    return (
      <span className="badge badge-dim" role="status" aria-live="polite" aria-atomic="true">
        아직 조회 안 함
      </span>
    );
  }
  const key = `${status.freshness}-${status.error_code}-${status.sequence}`;
  if (status.freshness === "fresh") {
    return (
      <span key={key} className="badge badge-fresh pulse" role="status" aria-live="polite" aria-atomic="true">
        fresh · 정상
      </span>
    );
  }
  return (
    <span key={key} className="badge badge-stale pulse" role="status" aria-live="polite" aria-atomic="true">
      stale(오래된 값) · {ERROR_LABEL[status.error_code] ?? status.error_code}
    </span>
  );
}

// 값이 바뀔 때 이전 값에서 새 값으로 부드럽게 올라가는 숫자 카운트업.
function useCountUp(target: number | null, durationMs = 600) {
  const [display, setDisplay] = useState<number | null>(target);
  const prevRef = useRef<number | null>(target);
  const frameRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    try {
      reducedMotionRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      reducedMotionRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (target == null) {
      frameRef.current = requestAnimationFrame(() => setDisplay(null));
      return;
    }
    const from = prevRef.current ?? target;
    if (from === target || reducedMotionRef.current) {
      frameRef.current = requestAnimationFrame(() => {
        setDisplay(target);
        prevRef.current = target;
      });
      return;
    }
    const start = performance.now();
    const animate = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (target - from) * eased);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(animate);
      } else {
        prevRef.current = target;
      }
    };
    frameRef.current = requestAnimationFrame(animate);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [target, durationMs]);

  return display;
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 2.5v2.4M12 19.1v2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="warning-icon">
      <path
        d="M12 3.5 21.5 20h-19L12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 9.5v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="17" r="1" fill="currentColor" />
    </svg>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-header">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </header>
      {children}
    </section>
  );
}

function DailyTable({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return <p className="empty">저장된 일별 기록이 아직 없습니다.</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>날짜(KST)</th>
            <th>값</th>
            <th>단위</th>
            <th>첫 조회</th>
            <th>마지막 조회</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.record_date}>
              <td>{r.record_date}</td>
              <td className="mono">{r.normalized_value.toLocaleString("ko-KR")}</td>
              <td>{r.unit}</td>
              <td className="mono">{fmtTime(r.first_fetched_at)}</td>
              <td className="mono">{fmtTime(r.last_fetched_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type PositionMarker = {
  id: number;
  entryPrice: number;
  direction: "long" | "short";
  stopLossPrice: number | null;
  liquidationPrice?: number | null;
};

function fmtChartTime(ms: number): string {
  try {
    const parts = new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
  } catch {
    return "";
  }
}

function Sparkline({
  points,
  positions,
  height,
  compact,
  times,
  intervalLabel: intervalLabelText,
}: {
  points: number[];
  positions?: PositionMarker[];
  height?: number;
  compact?: boolean;
  times?: number[];
  intervalLabel?: string;
}) {
  if (!points || points.length < 2) return <p className="empty">차트 데이터가 아직 없습니다.</p>;
  const w = 600;
  const h = height ?? 140;
  const showAxes = !compact;
  const hasTimeAxis = showAxes && !!times && times.length === points.length;
  const leftPad = showAxes ? 54 : 0;
  const rightPad = positions && positions.length && !compact ? 46 : 0;
  const bottomAxisPad = hasTimeAxis ? 16 : 0;
  const chartW = w - rightPad - leftPad;
  const topPad = 8;
  const bottomPad = 8;
  const plotH = h - topPad - bottomPad - bottomAxisPad;

  // 레버리지 포지션의 청산가는 실제 시세와 크게 동떨어질 수 있다. 축 범위를 청산가까지
  // 늘리면 진짜 가격선이 바닥에 눌려 납작해지므로, 축은 항상 가격 데이터로만 정한다.
  const priceMin = Math.min(...points);
  const priceMax = Math.max(...points);
  const pad = (priceMax - priceMin) * 0.08 || priceMax * 0.02 || 1;
  const min = priceMin - pad;
  const max = priceMax + pad;
  const range = max - min || 1;
  const step = chartW / (points.length - 1);
  const x = (i: number) => leftPad + i * step;
  const yRaw = (v: number) => topPad + plotH - ((v - min) / range) * plotH;
  const coords = points.map((p, i) => `${x(i).toFixed(1)},${yRaw(p).toFixed(1)}`);
  const up = points[points.length - 1] >= points[0];
  const areaPath = `M${leftPad},${topPad + plotH} L${coords.join(" L")} L${leftPad + chartW},${topPad + plotH} Z`;
  const linePath = `M${coords.join(" L")}`;
  const color = up ? "var(--fresh)" : "var(--error)";

  // x축 시간 눈금: 처음/끝 포함 4개.
  const timeTickIdx = hasTimeAxis
    ? [0, Math.round((points.length - 1) / 3), Math.round(((points.length - 1) * 2) / 3), points.length - 1]
    : [];

  // 값이 가격 축 범위 안이면 실제 위치에 줄과 낱개 라벨을 그리고, 범위를 벗어나면
  // (레버리지 손절/청산가가 실제 시세와 너무 동떨어진 경우) 개별 줄을 늘어놓는 대신
  // "N건 · 범위 밖(위/아래)"로 묶어서 보여준다 — 축을 늘리지 않고도 값을 숨기지 않기 위함.
  type MarkerKind = "진입" | "손절" | "청산";
  const markerColor: Record<MarkerKind, string> = { 진입: "var(--accent)", 손절: "var(--stale)", 청산: "var(--error)" };
  type Marker = { id: number; kind: MarkerKind; value: number; yRaw: number };
  const markers: Marker[] = (positions ?? []).flatMap((p) => {
    const out: Marker[] = [{ id: p.id, kind: "진입", value: p.entryPrice, yRaw: yRaw(p.entryPrice) }];
    if (p.stopLossPrice != null) out.push({ id: p.id, kind: "손절", value: p.stopLossPrice, yRaw: yRaw(p.stopLossPrice) });
    if (p.liquidationPrice != null) out.push({ id: p.id, kind: "청산", value: p.liquidationPrice, yRaw: yRaw(p.liquidationPrice) });
    return out;
  });
  const inRange = markers.filter((m) => m.yRaw >= topPad && m.yRaw <= topPad + plotH);
  const offTop = markers.filter((m) => m.yRaw < topPad);
  const offBottom = markers.filter((m) => m.yRaw > topPad + plotH);

  // 화면 안에 있는 라벨끼리만 겹치지 않게 최소 간격을 둔다.
  const sortedIn = [...inRange].sort((a, b) => a.yRaw - b.yRaw);
  const minGap = 10;
  const labelY = new Map<Marker, number>();
  sortedIn.forEach((m, i) => {
    const prev = i > 0 ? labelY.get(sortedIn[i - 1])! : undefined;
    labelY.set(m, prev != null && m.yRaw - prev < minGap ? prev + minGap : m.yRaw);
  });

  const offSummary = (list: Marker[]) => {
    const counts: Record<MarkerKind, number> = { 진입: 0, 손절: 0, 청산: 0 };
    list.forEach((m) => counts[m.kind]++);
    return (["진입", "손절", "청산"] as MarkerKind[])
      .filter((k) => counts[k] > 0)
      .map((k) => ({ kind: k, count: counts[k] }));
  };
  const offTopSummary = offSummary(offTop);
  const offBottomSummary = offSummary(offBottom);

  return (
    <>
    <svg viewBox={`0 0 ${w} ${h}`} className="sparkline" preserveAspectRatio="none" role="img" aria-label="7일 가격 추세, 보유 중인 포지션의 진입·손절선 포함">
      <path d={areaPath} fill={color} opacity="0.12" />
      <path d={linePath} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />

      {inRange.map((m, i) => (
        <g key={`in-${m.id}-${m.kind}-${i}`}>
          <line
            x1={leftPad}
            y1={m.yRaw}
            x2={leftPad + chartW}
            y2={m.yRaw}
            stroke={markerColor[m.kind]}
            strokeWidth={m.kind === "진입" ? 1.3 : 1}
            strokeDasharray={m.kind === "진입" ? "5 3" : m.kind === "손절" ? "3 3" : "2 3"}
            opacity={m.kind === "청산" ? 0.6 : 1}
          />
          {m.kind === "진입" && <circle cx={Math.max(leftPad + 3, leftPad + chartW - 3)} cy={m.yRaw} r="3.5" fill={markerColor.진입} />}
          {!compact && (
            <text x={leftPad + chartW + 4} y={(labelY.get(m) ?? m.yRaw) + 3} fontSize="9" fill={markerColor[m.kind]}>
              #{m.id} {m.kind}
            </text>
          )}
        </g>
      ))}

      {/* 범위를 벗어난 값은 가장자리에 짧은 화살촉 눈금만 찍고, 개수는 아래 캡션으로 요약한다. */}
      {offTop.map((m, i) => (
        <polygon
          key={`off-top-${m.id}-${m.kind}-${i}`}
          points={`${leftPad + chartW - 8 - i * 7},${topPad + 5} ${leftPad + chartW - 2 - i * 7},${topPad + 5} ${leftPad + chartW - 5 - i * 7},${topPad}`}
          fill={markerColor[m.kind]}
          opacity="0.85"
        />
      ))}
      {offBottom.map((m, i) => (
        <polygon
          key={`off-bottom-${m.id}-${m.kind}-${i}`}
          points={`${leftPad + chartW - 8 - i * 7},${topPad + plotH - 5} ${leftPad + chartW - 2 - i * 7},${topPad + plotH - 5} ${leftPad + chartW - 5 - i * 7},${topPad + plotH}`}
          fill={markerColor[m.kind]}
          opacity="0.85"
        />
      ))}

      {showAxes && (
        <g className="chart-axis">
          <text x={leftPad - 6} y={topPad + 4} fontSize="8.5" textAnchor="end" fill="var(--text-dim)">
            {Math.round(priceMax).toLocaleString("ko-KR")}
          </text>
          <text x={leftPad - 6} y={topPad + plotH} fontSize="8.5" textAnchor="end" fill="var(--text-dim)">
            {Math.round(priceMin).toLocaleString("ko-KR")}
          </text>
        </g>
      )}

      {hasTimeAxis && (
        <g className="chart-axis">
          {timeTickIdx.map((idx, i) => (
            <text
              key={`t-${idx}`}
              x={x(idx)}
              y={topPad + plotH + bottomAxisPad - 2}
              fontSize="8.5"
              textAnchor={i === 0 ? "start" : i === timeTickIdx.length - 1 ? "end" : "middle"}
              fill="var(--text-dim)"
            >
              {fmtChartTime(times![idx])}
            </text>
          ))}
        </g>
      )}
    </svg>
    {showAxes && intervalLabelText && (
      <p className="hint chart-interval-hint">{intervalLabelText} · 시간은 Asia/Seoul(KST) 기준</p>
    )}
    {!compact && (offTopSummary.length > 0 || offBottomSummary.length > 0) && (
      <p className="hint offrange-hint">
        ▲ 범위 위: {offTopSummary.length ? offTopSummary.map((s) => `${s.kind} ${s.count}건`).join(" · ") : "없음"}
        {" · "}
        ▼ 범위 아래: {offBottomSummary.length ? offBottomSummary.map((s) => `${s.kind} ${s.count}건`).join(" · ") : "없음"}
        {" "}(레버리지로 실제 시세와 크게 떨어진 값 — 정확한 값은 포지션 카드 참고)
      </p>
    )}
    </>
  );
}

// 손익 숫자를 매 폴링마다 스냅되지 않고 부드럽게 카운트업시켜서 "멈춰 보임"을 없앤다.
function PositionCard({
  pos,
  sparkline,
  onClose,
  busy,
}: {
  pos: SimPosition;
  sparkline: number[];
  onClose: (id: number) => void;
  busy: number | "advice" | null;
}) {
  const displayPnlAmount = useCountUp(pos.pnl_amount ?? null, 500);
  const displayPnlPct = useCountUp(pos.pnl_pct ?? null, 500);
  const displayCurrentPrice = useCountUp(pos.current_price ?? null, 500);

  return (
    <div className="position-card">
      <div className="position-card-head">
        <div>
          <div className="position-card-title">
            {pos.direction === "long" ? "롱" : "숏"} × {pos.leverage}
          </div>
          <div className="hint">진입가 {fmtKrw(pos.entry_price)}</div>
        </div>
        <span className={`badge badge-sm ${pos.opened_by === "ai_auto" ? "badge-ai" : "badge-dim"}`}>
          {pos.opened_by === "ai_auto" ? "AI" : "수동"}
        </span>
      </div>

      {displayPnlAmount != null && (
        <div className={`delta ${displayPnlAmount >= 0 ? "up" : "down"}`} role="status" aria-live="polite">
          {displayPnlAmount >= 0 ? "+" : ""}
          {fmtKrw(Math.round(displayPnlAmount))} KRW ({(displayPnlPct ?? 0).toFixed(2)}%)
        </div>
      )}

      <Sparkline
        points={sparkline}
        height={64}
        compact
        positions={[
          {
            id: pos.id,
            entryPrice: pos.entry_price,
            direction: pos.direction,
            stopLossPrice:
              pos.stop_loss_pct != null
                ? pos.direction === "long"
                  ? pos.entry_price * (1 - pos.stop_loss_pct / 100)
                  : pos.entry_price * (1 + pos.stop_loss_pct / 100)
                : null,
            liquidationPrice: pos.liquidation_price ?? null,
          },
        ]}
      />

      <dl className="meta-grid meta-grid-compact">
        <dt>현재가</dt>
        <dd className="mono">{fmtKrw(displayCurrentPrice != null ? Math.round(displayCurrentPrice) : null)}</dd>
        <dt>청산가</dt>
        <dd className="mono">{fmtKrw(pos.liquidation_price)}</dd>
        <dt>규모</dt>
        <dd className="mono">{fmtKrw(pos.virtual_size)}</dd>
        {pos.stop_loss_pct != null && (
          <>
            <dt>손절</dt>
            <dd>-{pos.stop_loss_pct}%</dd>
          </>
        )}
        {pos.entry_confidence != null && (
          <>
            <dt>신뢰도</dt>
            <dd>{pos.entry_confidence}%</dd>
          </>
        )}
      </dl>

      {pos.rationale && (
        <p className="position-card-rationale" title={pos.rationale}>
          {pos.rationale}
        </p>
      )}

      <button className="btn ghost btn-sm" onClick={() => onClose(pos.id)} disabled={busy !== null}>
        {busy === pos.id ? "처리 중…" : "지금 청산"}
      </button>
    </div>
  );
}

export default function Home() {
  const [live, setLive] = useState<ReadingResponse | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [demo, setDemo] = useState<{ rows: Row[]; status: Status } | null>(null);
  const [demoBusy, setDemoBusy] = useState<string | null>(null);
  const [lastFixture, setLastFixture] = useState<string | null>(null);

  const [stats, setStats] = useState<Stats | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);

  const [openPositions, setOpenPositions] = useState<SimPosition[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [history, setHistory] = useState<SimPosition[]>([]);
  const [advice, setAdvice] = useState<AdviceOption[] | null>(null);
  const [adviceSource, setAdviceSource] = useState<string | null>(null);
  const [adviceMsg, setAdviceMsg] = useState<string | null>(null);
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [simBusy, setSimBusy] = useState<number | "advice" | null>(null);
  const [manualDirection, setManualDirection] = useState<"long" | "short">("long");
  const [manualLeverage, setManualLeverage] = useState(2);
  const [manualPct, setManualPct] = useState(25);
  const [manualStopLoss, setManualStopLoss] = useState("");
  const [simUpdatedAt, setSimUpdatedAt] = useState<number | null>(null);
  const [settings, setSettings] = useState<SimSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [draftMaxAlloc, setDraftMaxAlloc] = useState(25);
  const [draftConfThreshold, setDraftConfThreshold] = useState(70);
  const [draftMaxConcurrent, setDraftMaxConcurrent] = useState(3);
  const settingsSeededRef = useRef(false);
  const [decisionLog, setDecisionLog] = useState<DecisionLogRow[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const stored = window.localStorage.getItem("t04-openai-key");
        if (stored) {
          setApiKey(stored);
          setApiKeySaved(true);
        }
      } catch {
        // localStorage 접근 불가(프라이빗 모드 등) — 무시하고 키 없이 진행
      }

      try {
        const savedTheme = window.localStorage.getItem("t04-theme");
        if (savedTheme === "light" || savedTheme === "dark") {
          setTheme(savedTheme);
        } else if (window.matchMedia("(prefers-color-scheme: light)").matches) {
          setTheme("light");
        }
      } catch {
        // 무시 — 기본 다크 테마 유지
      }
    });
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      window.localStorage.setItem("t04-theme", next);
    } catch {
      // 무시
    }
  }

  function saveApiKey() {
    const trimmed = apiKeyInput.trim();
    try {
      if (trimmed) {
        window.localStorage.setItem("t04-openai-key", trimmed);
      } else {
        window.localStorage.removeItem("t04-openai-key");
      }
    } catch {
      // 무시
    }
    setApiKey(trimmed);
    setApiKeySaved(Boolean(trimmed));
    setApiKeyInput("");
  }

  function clearApiKey() {
    try {
      window.localStorage.removeItem("t04-openai-key");
    } catch {
      // 무시
    }
    setApiKey("");
    setApiKeySaved(false);
  }

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadLive = useCallback(async () => {
    setLiveLoading(true);
    try {
      const res = await fetch("/api/reading", { cache: "no-store" });
      const json = (await res.json()) as ReadingResponse;
      setLive(json);
    } finally {
      setLiveLoading(false);
    }
  }, []);

  const loadDemo = useCallback(async () => {
    const res = await fetch("/api/replay", { cache: "no-store" });
    const json = (await res.json()) as { rows: Row[]; status: Status };
    setDemo(json);
  }, []);

  const loadStats = useCallback(async () => {
    const res = await fetch("/api/bitcoin-stats", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { ok: boolean } & Stats;
    if (json.ok) setStats(json);
  }, []);

  const loadNews = useCallback(async () => {
    const res = await fetch("/api/news", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { ok: boolean; items: NewsItem[] };
    if (json.ok) setNews(json.items);
  }, []);

  const loadSim = useCallback(async () => {
    const res = await fetch("/api/sim/positions", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as {
      ok: boolean;
      open: SimPosition[];
      history: SimPosition[];
      wallet: Wallet;
    };
    if (json.ok) {
      setOpenPositions(json.open);
      setHistory(json.history);
      setWallet(json.wallet);
      setSimUpdatedAt(Date.now());
    }
  }, []);

  const loadSettings = useCallback(async () => {
    const res = await fetch("/api/sim/settings", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { ok: boolean; settings: SimSettings };
    if (json.ok) setSettings(json.settings);
  }, []);

  // 슬라이더 값은 처음 한 번만 서버 설정으로 채우고, 이후엔 드래그 중 배경 폴링이
  // 끼어들어 슬라이더를 되돌리지 않도록 로컬 상태를 그대로 둔다.
  useEffect(() => {
    if (settings && !settingsSeededRef.current) {
      setDraftMaxAlloc(settings.max_allocation_pct);
      setDraftConfThreshold(settings.confidence_threshold);
      setDraftMaxConcurrent(settings.max_concurrent_positions);
      settingsSeededRef.current = true;
    }
  }, [settings]);

  const loadDecisionLog = useCallback(async () => {
    const res = await fetch("/api/sim/log", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { ok: boolean; log: DecisionLogRow[] };
    if (json.ok) setDecisionLog(json.log);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => {
      loadLive();
      loadDemo();
      loadStats();
      loadNews();
      loadSim();
      loadSettings();
      loadDecisionLog();
    });

    pollRef.current = setInterval(() => {
      loadStats();
      loadSim();
      loadSettings();
      loadDecisionLog();
    }, 30_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadLive, loadDemo, loadStats, loadNews, loadSim, loadSettings, loadDecisionLog]);

  // 포지션이 하나라도 열려 있거나 자동매매가 켜져 있으면 더 자주 갱신한다.
  // CoinGecko 무료 API 호출 제한을 피하려고 서버 DB 캐시가 20초 단위라, 그보다 촘촘히
  // 돌아봤자 새 값은 없이 요청 수만 늘어난다 — 캐시 주기에 맞춰 10초로 완화.
  const hasOpenPosition = openPositions.length > 0;
  const autoTradingOn = settings?.auto_trading_enabled ?? false;
  useEffect(() => {
    if (!hasOpenPosition && !autoTradingOn) return;
    const fast = setInterval(() => {
      loadSim();
      loadDecisionLog();
    }, 10_000);
    return () => clearInterval(fast);
  }, [hasOpenPosition, autoTradingOn, loadSim, loadDecisionLog]);

  const [liveSecondsAgo, setLiveSecondsAgo] = useState(0);
  useEffect(() => {
    const tick = setInterval(() => {
      if (simUpdatedAt) setLiveSecondsAgo(Math.floor((Date.now() - simUpdatedAt) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [simUpdatedAt]);

  async function runFixture(id: string) {
    setDemoBusy(id);
    try {
      const res = await fetch("/api/replay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fixture_id: id }),
      });
      const json = (await res.json()) as { rows: Row[]; status: Status };
      setDemo(json);
      setLastFixture(id);
    } finally {
      setDemoBusy(null);
    }
  }

  async function resetDemo() {
    setDemoBusy("reset");
    try {
      await fetch("/api/reset", { method: "POST" });
      setLastFixture(null);
      await loadDemo();
    } finally {
      setDemoBusy(null);
    }
  }

  function ruleBasedAdvice(): AdviceOption[] {
    const change = stats?.change24hPct ?? 0;
    const bullish = change >= 0;
    return [
      {
        direction: bullish ? "long" : "short",
        leverage: 2,
        pct: 25,
        stopLossPct: 10,
        confidence: 55,
        rationale: bullish
          ? `24시간 변동 +${change.toFixed(2)}%로 상승세라 추세 추종. 규칙 기반 추정이라 신뢰도는 중간 수준(55%)으로 제한.`
          : `24시간 변동 ${change.toFixed(2)}%로 하락세라 추세 추종. 규칙 기반 추정이라 신뢰도는 중간 수준(55%)으로 제한.`,
      },
      {
        direction: "long",
        leverage: 1,
        pct: 10,
        stopLossPct: 15,
        confidence: 50,
        rationale: "무배수에 가까운 안전한 롱 관망안. 방향성 근거가 약해 신뢰도를 50%로 중립적으로 매김.",
      },
      {
        direction: "short",
        leverage: 5,
        pct: 10,
        stopLossPct: 8,
        confidence: 40,
        rationale: "변동성 베팅용 고배수 숏(재미용). 레버리지가 높아 리스크가 커서 신뢰도를 40%로 낮게 매김.",
      },
    ];
  }

  function parseAiOptions(raw: unknown): AdviceOption[] | null {
    const obj = raw as { options?: unknown };
    if (!Array.isArray(obj.options) || obj.options.length === 0) return null;
    const out: AdviceOption[] = [];
    for (const item of obj.options.slice(0, 3)) {
      if (!item || typeof item !== "object") return null;
      const o = item as Record<string, unknown>;
      if (o.direction !== "long" && o.direction !== "short") return null;
      const lev = Number(o.leverage);
      const pct = Number(o.pct);
      const stopLossPct = Number(o.stopLossPct);
      const confidence = Number(o.confidence);
      if (!Number.isInteger(lev) || lev < 1 || lev > 10) return null;
      if (!Number.isFinite(pct) || pct < 10 || pct > 100) return null;
      if (!Number.isFinite(stopLossPct) || stopLossPct < 1 || stopLossPct > 90) return null;
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) return null;
      out.push({
        direction: o.direction,
        leverage: lev,
        pct: Math.round(pct),
        stopLossPct: Math.round(stopLossPct),
        confidence: Math.round(confidence),
        rationale: typeof o.rationale === "string" ? o.rationale.slice(0, 220) : "",
      });
    }
    return out.length ? out : null;
  }

  async function requestAdvice() {
    setAdviceLoading(true);
    setAdviceMsg(null);
    try {
      if (!apiKey) {
        setAdvice(ruleBasedAdvice());
        setAdviceSource("rule");
        return;
      }

      const sparkline = stats?.sparkline7d ?? [];
      const sparkMin = sparkline.length ? Math.min(...sparkline) : 0;
      const sparkMax = sparkline.length ? Math.max(...sparkline) : 0;
      const priceText = stats ? stats.price.toLocaleString("ko-KR") : "알 수 없음";
      const changeText = stats ? stats.change24hPct.toFixed(2) : "0";

      let performanceText = "";
      try {
        const perfRes = await fetch("/api/sim/performance", { cache: "no-store" });
        if (perfRes.ok) {
          const perfJson = (await perfRes.json()) as { ok: boolean; summary?: string };
          if (perfJson.ok && perfJson.summary) performanceText = ` 최근 성과 피드백: ${perfJson.summary}`;
        }
      } catch {
        // 성과 피드백은 있으면 좋고 없어도 무방
      }

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.7,
          max_tokens: 700,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "당신은 오락용 가상 모의투자 게임의 도우미입니다. 실제 금융 조언이 아니고, 참가자는 실제 자금이 아닌 가상 자금으로만 놉니다. " +
                "주어진 시세와 최근 성과 피드백을 참고해 재미있는 가상 포지션 추천안 정확히 3개를 만드세요. 확신이 낮을수록 pct(비중)를 작게, stopLossPct(손절폭)를 타이트하게 제안하세요. " +
                "rationale은 반드시 두 부분으로 구성하세요: (1) 방향 판단 근거 — 24시간 변동률·7일 구간·현재가 같은 구체적 수치를 최소 1개 인용, " +
                "(2) '신뢰도 N%인 이유' — 왜 그 확신 수준인지 명시. 한 문장으로 이어 총 70~120자 한국어로 쓰세요. " +
                '반드시 {"options":[{"direction":"long|short","leverage":정수(1~10),"pct":정수(10~100),"stopLossPct":정수(1~90),"confidence":정수(0~100),"rationale":"70~120자, 수치 인용 + 신뢰도 근거 포함"}, ...]} 형태의 JSON 객체만 답하세요. 다른 설명은 쓰지 마세요.',
            },
            {
              role: "user",
              content: `비트코인 현재가 ${priceText}KRW, 24시간 변동 ${changeText}%, 7일 구간 ${sparkMin.toFixed(0)}~${sparkMax.toFixed(0)}KRW.${performanceText}`,
            },
          ],
        }),
      });

      if (!res.ok) {
        setAdviceMsg(res.status === 401 ? "API 키가 올바르지 않습니다. 규칙 기반 추천으로 대신합니다." : "OpenAI 호출 실패, 규칙 기반 추천으로 대신합니다.");
        setAdvice(ruleBasedAdvice());
        setAdviceSource("rule-fallback");
        return;
      }

      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = json.choices?.[0]?.message?.content;
      const parsed = content ? parseAiOptions(JSON.parse(content)) : null;
      if (parsed) {
        setAdvice(parsed);
        setAdviceSource("openai");
      } else {
        setAdviceMsg("AI 응답 형식이 이상해 규칙 기반 추천으로 대신합니다.");
        setAdvice(ruleBasedAdvice());
        setAdviceSource("rule-fallback");
      }
    } catch {
      setAdviceMsg("호출 중 오류가 발생해 규칙 기반 추천으로 대신합니다. (브라우저 CORS 차단일 수 있음)");
      setAdvice(ruleBasedAdvice());
      setAdviceSource("rule-fallback");
    } finally {
      setAdviceLoading(false);
    }
  }

  async function enterPosition(
    direction: "long" | "short",
    leverage: number,
    rationale?: string,
    overridePct?: number,
    overrideStopLoss?: number,
    confidence?: number
  ) {
    setSimBusy("advice");
    try {
      const pct = overridePct ?? manualPct;
      const stopLossPct = overrideStopLoss ?? (manualStopLoss.trim() ? Number(manualStopLoss.trim()) : null);
      const res = await fetch("/api/sim/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ direction, leverage, pct, stopLossPct, rationale, confidence: confidence ?? null }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (json.ok) {
        setAdvice(null);
        await loadSim();
      } else {
        setAdviceMsg(json.error === "insufficient balance" ? "가용 자금이 부족합니다." : "진입에 실패했습니다.");
      }
    } finally {
      setSimBusy(null);
    }
  }

  async function closePositionById(id: number) {
    setSimBusy(id);
    try {
      await fetch("/api/sim/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await loadSim();
    } finally {
      setSimBusy(null);
    }
  }

  async function patchSettings(
    patch: Partial<Pick<SimSettings, "auto_trading_enabled" | "max_allocation_pct" | "confidence_threshold" | "max_concurrent_positions">>
  ) {
    setSettingsBusy(true);
    try {
      const res = await fetch("/api/sim/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = (await res.json()) as { ok: boolean; settings?: SimSettings };
      if (json.ok && json.settings) setSettings(json.settings);
    } finally {
      setSettingsBusy(false);
    }
  }

  async function resetSimAll() {
    if (!window.confirm("시뮬레이터의 잔고·보유/청산 기록·AI 판단 로그를 모두 지웁니다. 자동매매 설정(ON/OFF, 상한 등)은 유지됩니다. 계속할까요?")) {
      return;
    }
    setSettingsBusy(true);
    try {
      await fetch("/api/sim/reset", { method: "POST" });
      setAdvice(null);
      await Promise.all([loadSim(), loadDecisionLog(), loadSettings()]);
    } finally {
      setSettingsBusy(false);
    }
  }

  const cur = live?.current;
  const liveDisplayValue = useCountUp(cur?.normalized_value ?? null);
  const statsDisplayPrice = useCountUp(stats?.price ?? null, 500);

  const portfolioStats = useMemo(() => {
    if (history.length === 0) return null;
    const pnls = history.map(closedPnlAmount).filter((v): v is number => v != null);
    const wins = pnls.filter((v) => v > 0).length;
    const total = pnls.reduce((sum, v) => sum + v, 0);
    return {
      count: history.length,
      winRatePct: pnls.length ? (wins / pnls.length) * 100 : 0,
      totalPnl: total,
    };
  }, [history]);

  const [activeTab, setActiveTab] = useState<(typeof TABS)[number]["id"]>("live");

  return (
    <main className="page">
      <header className="hero">
        <div>
          <h1>오늘의 진짜 정보판</h1>
          <p>데이터가 안 올 때, 값을 지어내지 않고 정직하게 보여줍니다.</p>
        </div>
        <button
          type="button"
          className="btn ghost theme-toggle"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환"}
        >
          {theme === "dark" ? (
            <>
              <MoonIcon /> 다크
            </>
          ) : (
            <>
              <SunIcon /> 라이트
            </>
          )}
        </button>
      </header>

      <nav className="tabs" role="tablist" aria-label="정보판 섹션">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={activeTab === t.id}
            aria-controls={`panel-${t.id}`}
            className={`tab ${activeTab === t.id ? "active" : ""}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div id="panel-live" role="tabpanel" aria-labelledby="tab-live" hidden={activeTab !== "live"}>
      <Panel
        title="① 실제 정보판 (비트코인 KRW 시세)"
        subtitle="비개인 공개 원천(CoinGecko)에서 실시간 값을 조회합니다. 로그인·API 키 없음."
      >
        <div className="live-card">
          <div className="live-value-row">
            <div>
              <div className="live-value">
                {liveDisplayValue != null ? Math.round(liveDisplayValue).toLocaleString("ko-KR") : "—"}
                <span className="unit">{cur?.unit ?? ""}</span>
              </div>
              {live?.delta != null && (
                <div className={`delta ${live.delta >= 0 ? "up" : "down"}`}>
                  전일 대비 {live.delta >= 0 ? "+" : ""}
                  {live.delta.toLocaleString("ko-KR")}
                </div>
              )}
            </div>
            <StatusBadge status={live?.status ?? null} />
          </div>

          <dl className="meta-grid">
            <dt>출처</dt>
            <dd>
              {cur ? (
                <a href={cur.source_url} target="_blank" rel="noreferrer">
                  {cur.source_name}
                </a>
              ) : (
                "—"
              )}
            </dd>
            <dt>출처 시각</dt>
            <dd className="mono">{fmtTime(cur?.source_time ?? null)}</dd>
            <dt>조회 시각</dt>
            <dd className="mono">{fmtTime((cur as unknown as { fetched_at?: string })?.fetched_at ?? null)}</dd>
            <dt>기준 시간대</dt>
            <dd>Asia/Seoul (KST)</dd>
          </dl>

          <button className="btn primary" onClick={loadLive} disabled={liveLoading}>
            {liveLoading ? "조회 중…" : "다시 조회"}
          </button>
        </div>

        <h3 className="subhead">저장된 일별 기록</h3>
        <DailyTable rows={live?.rows ?? []} />
      </Panel>
      </div>

      <div id="panel-chart" role="tabpanel" aria-labelledby="tab-chart" hidden={activeTab !== "chart"}>
      <Panel title="② 7일 추세 & 24시간 통계" subtitle="30초마다 자동 새로고침됩니다. 그래프·통계는 채점 저장소와 분리된 참고용입니다.">
        <div className="live-card">
          <Sparkline
            points={stats?.sparkline7d ?? []}
            times={stats?.sparkline7dTimes}
            intervalLabel={stats?.sparklineIntervalLabel}
            height={180}
          />
          <div className="stat-grid">
            <div className="stat-tile">
              <span className="stat-label">현재가</span>
              <span className="stat-value">{fmtKrw(statsDisplayPrice != null ? Math.round(statsDisplayPrice) : null)} KRW</span>
            </div>
            <div className={`stat-tile ${stats && stats.change24hPct >= 0 ? "up" : "down"}`}>
              <span className="stat-label">24시간 변동</span>
              <span className="stat-value">
                {stats ? `${stats.change24hPct >= 0 ? "+" : ""}${stats.change24hPct.toFixed(2)}%` : "—"}
              </span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">24h 고가</span>
              <span className="stat-value">{fmtKrw(stats?.high24h)}</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">24h 저가</span>
              <span className="stat-value">{fmtKrw(stats?.low24h)}</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">24h 거래대금</span>
              <span className="stat-value">{fmtKrw(stats?.volume24h)}</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">시가총액</span>
              <span className="stat-value">{fmtKrw(stats?.marketCap)}</span>
            </div>
          </div>
        </div>
      </Panel>
      </div>

      <div id="panel-news" role="tabpanel" aria-labelledby="tab-news" hidden={activeTab !== "news"}>
      <Panel title="③ 실시간 이슈" subtitle="비트코인 관련 최신 뉴스 (Google 뉴스 RSS, 비개인 공개 원천)">
        {news.length === 0 ? (
          <p className="empty">뉴스를 불러오는 중이거나 아직 없습니다.</p>
        ) : (
          <ul className="news-list">
            {news.map((n, i) => (
              <li key={i}>
                <a href={n.link} target="_blank" rel="noreferrer">
                  {n.title}
                </a>
                <span className="news-meta">
                  {n.source} · {fmtTime(n.pubDate)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      </div>

      <div id="panel-auto" role="tabpanel" aria-labelledby="tab-auto" hidden={activeTab !== "auto"}>
      <Panel title="④ AI 자동매매 (오락용)" subtitle="가상 총자산 안에서 AI가 신뢰도 기준을 넘는 거래만 스스로 실행합니다. 실제 투자 조언이 아니며 실제 거래는 없습니다.">
        <div className="disclaimer">
          <WarningIcon />
          <span>이 섹션은 재미를 위한 시뮬레이션입니다. AI 추천은 실제 금융 조언이 아니며, 실제 자금 거래를 발생시키지 않습니다.</span>
        </div>

        <h3 className="subhead">7일 가격 추세 · 보유 포지션 한눈에 보기</h3>
        <div className="live-card chart-overview">
          {stats?.sparkline7d && stats.sparkline7d.length >= 2 ? (
            <>
              <Sparkline
                points={stats.sparkline7d}
                times={stats.sparkline7dTimes}
                intervalLabel={stats.sparklineIntervalLabel}
                height={190}
                positions={openPositions.map((p) => ({
                  id: p.id,
                  entryPrice: p.entry_price,
                  direction: p.direction,
                  stopLossPrice:
                    p.stop_loss_pct != null
                      ? p.direction === "long"
                        ? p.entry_price * (1 - p.stop_loss_pct / 100)
                        : p.entry_price * (1 + p.stop_loss_pct / 100)
                      : null,
                  liquidationPrice: p.liquidation_price ?? null,
                }))}
              />
              <ul className="chart-legend">
                <li>
                  <span className="legend-swatch" style={{ background: "var(--fresh)" }} /> 7일 가격 추세
                </li>
                {openPositions.length > 0 && (
                  <>
                    <li>
                      <span className="legend-swatch" style={{ background: "var(--accent)" }} /> 진입가
                    </li>
                    <li>
                      <span className="legend-swatch legend-dash" style={{ borderColor: "var(--stale)" }} /> 손절가
                    </li>
                    <li>
                      <span className="legend-swatch legend-dash" style={{ borderColor: "var(--error)" }} /> 청산가
                    </li>
                  </>
                )}
              </ul>
            </>
          ) : (
            <p className="empty">가격 추세 데이터를 불러오는 중이거나 아직 없습니다.</p>
          )}
        </div>

        <div className="demo-toolbar">
          <button className="btn ghost" onClick={resetSimAll} disabled={settingsBusy}>
            {settingsBusy ? "초기화 중…" : "시뮬레이터 전체 초기화(잔고·기록·로그)"}
          </button>
        </div>

        {wallet && (
          <div className="stat-grid sim-summary">
            <div className="stat-tile">
              <span className="stat-label">총자산</span>
              <span className="stat-value">{fmtKrw(Math.round(wallet.total))} KRW</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">가용 자금</span>
              <span className="stat-value">{fmtKrw(Math.round(wallet.available))} KRW</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">포지션에 묶임</span>
              <span className="stat-value">{fmtKrw(Math.round(wallet.locked))} KRW</span>
            </div>
          </div>
        )}

        <p className="hint live-heartbeat">
          <span className={`live-dot ${hasOpenPosition ? "on" : ""}`} aria-hidden="true" />
          {simUpdatedAt ? `${liveSecondsAgo}초 전 업데이트` : "업데이트 대기 중"} · 포지션 보유 중엔 3초마다 자동 갱신
        </p>

        <h3 className="subhead">자동매매 설정</h3>
        <div className="auto-settings">
          <label className="auto-toggle">
            <input
              type="checkbox"
              checked={settings?.auto_trading_enabled ?? false}
              disabled={settingsBusy || !settings}
              onChange={(e) => patchSettings({ auto_trading_enabled: e.target.checked })}
            />
            <span>
              자동매매 {settings?.auto_trading_enabled ? <b className="up">ON</b> : <b className="down">OFF</b>}
              {" "}— 서버가 5분마다(외부 크론 연결 시) AI 신뢰도를 확인해 조건 만족 시 스스로 매수·매도합니다.
            </span>
          </label>

          <label htmlFor="max-alloc">최대 비중 상한: {draftMaxAlloc}% (AI가 이보다 낮게 제안하면 낮은 쪽을 씀)</label>
          <input
            id="max-alloc"
            type="range"
            min={10}
            max={100}
            step={5}
            value={draftMaxAlloc}
            disabled={!settings}
            onChange={(e) => setDraftMaxAlloc(Number(e.target.value))}
            onMouseUp={(e) => patchSettings({ max_allocation_pct: Number(e.currentTarget.value) })}
            onTouchEnd={(e) => patchSettings({ max_allocation_pct: Number(e.currentTarget.value) })}
            onKeyUp={(e) => patchSettings({ max_allocation_pct: Number(e.currentTarget.value) })}
            className="pct-slider"
          />

          <label htmlFor="conf-threshold">AI 신뢰도 기준: {draftConfThreshold}% 이상일 때만 자동 실행</label>
          <input
            id="conf-threshold"
            type="range"
            min={1}
            max={100}
            step={1}
            value={draftConfThreshold}
            disabled={!settings}
            onChange={(e) => setDraftConfThreshold(Number(e.target.value))}
            onMouseUp={(e) => patchSettings({ confidence_threshold: Number(e.currentTarget.value) })}
            onTouchEnd={(e) => patchSettings({ confidence_threshold: Number(e.currentTarget.value) })}
            onKeyUp={(e) => patchSettings({ confidence_threshold: Number(e.currentTarget.value) })}
            className="pct-slider"
          />

          <label htmlFor="max-concurrent">AI 동시 보유 포지션 한도: {draftMaxConcurrent}건 (한 주기에 여러 추천안을 동시에 열 수 있음)</label>
          <input
            id="max-concurrent"
            type="range"
            min={1}
            max={10}
            step={1}
            value={draftMaxConcurrent}
            disabled={!settings}
            onChange={(e) => setDraftMaxConcurrent(Number(e.target.value))}
            onMouseUp={(e) => patchSettings({ max_concurrent_positions: Number(e.currentTarget.value) })}
            onTouchEnd={(e) => patchSettings({ max_concurrent_positions: Number(e.currentTarget.value) })}
            onKeyUp={(e) => patchSettings({ max_concurrent_positions: Number(e.currentTarget.value) })}
            className="pct-slider"
          />

          {settings?.last_run_at && (
            <p className="hint">
              마지막 자동실행: {fmtTime(settings.last_run_at)} — {settings.last_run_summary}
            </p>
          )}
          {!settings?.last_run_at && settings?.auto_trading_enabled && (
            <p className="hint">아직 자동실행 기록 없음 — 외부 크론이 연결되어 있는지 확인하세요.</p>
          )}
        </div>

        <h3 className="subhead">보유 중인 포지션 ({openPositions.length}건)</h3>
        {openPositions.length === 0 ? (
          <p className="empty">보유 중인 포지션이 없습니다.</p>
        ) : (
          <div className="positions-grid">
            {openPositions.map((pos) => (
              <PositionCard
                key={pos.id}
                pos={pos}
                sparkline={stats?.sparkline7d ?? []}
                onClose={closePositionById}
                busy={simBusy}
              />
            ))}
          </div>
        )}

        {portfolioStats && (
          <div className="stat-grid sim-summary">
            <div className="stat-tile">
              <span className="stat-label">누적 거래</span>
              <span className="stat-value">{portfolioStats.count}건</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">승률</span>
              <span className="stat-value">{portfolioStats.winRatePct.toFixed(0)}%</span>
            </div>
            <div className={`stat-tile ${portfolioStats.totalPnl >= 0 ? "up" : "down"}`}>
              <span className="stat-label">누적 손익</span>
              <span className="stat-value">
                {portfolioStats.totalPnl >= 0 ? "+" : ""}
                {fmtKrw(Math.round(portfolioStats.totalPnl))} KRW
              </span>
            </div>
          </div>
        )}

        <h3 className="subhead">거래 내역 (AI 근거·신뢰도 포함)</h3>
        {history.length === 0 ? (
          <p className="empty">아직 기록이 없습니다.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>방향</th>
                  <th>진입</th>
                  <th>종료</th>
                  <th>승패</th>
                  <th>실행주체</th>
                  <th>진입 근거(신뢰도)</th>
                  <th>종료 근거(신뢰도)</th>
                  <th>결과 설명</th>
                  <th>종료 시각</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  const pnl = closedPnlAmount(h);
                  const win = pnl != null && pnl > 0;
                  return (
                    <tr key={h.id}>
                      <td>
                        {h.direction === "long" ? "롱" : "숏"}×{h.leverage}
                      </td>
                      <td className="mono">{fmtKrw(h.entry_price)}</td>
                      <td className="mono">{fmtKrw(h.close_price)}</td>
                      <td className={win ? "up" : "down"}>
                        {win ? "승" : "패"}
                        {pnl != null && ` (${pnl >= 0 ? "+" : ""}${fmtKrw(Math.round(pnl))})`}
                      </td>
                      <td>{h.opened_by === "ai_auto" ? "AI 자동" : "수동"}</td>
                      <td className="log-cell">
                        {h.rationale ?? "—"}
                        {h.entry_confidence != null && ` (${h.entry_confidence}%)`}
                      </td>
                      <td className="log-cell">
                        {h.close_reason === "liquidation"
                          ? "강제청산(청산가 도달)"
                          : h.close_reason === "stop_loss"
                            ? "손절선 도달"
                            : h.exit_rationale
                              ? `${h.exit_rationale}${h.exit_confidence != null ? ` (${h.exit_confidence}%)` : ""}`
                              : "수동 종료"}
                      </td>
                      <td className="log-cell">{h.outcome_note ?? "—"}</td>
                      <td className="mono">{fmtTime(h.close_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <h3 className="subhead">AI 판단 로그 (실행 안 된 판단 포함)</h3>
        {decisionLog.length === 0 ? (
          <p className="empty">아직 로그가 없습니다.</p>
        ) : (
          <ul className="decision-log">
            {decisionLog.map((d) => (
              <li key={d.id}>
                <span className={`log-kind log-${d.kind}`}>{DECISION_KIND_LABEL[d.kind] ?? d.kind}</span>
                {d.position_id != null && <span className="mono"> #{d.position_id}</span>}
                {d.confidence != null && <span> 신뢰도 {d.confidence}%</span>}
                {d.rationale && <span> · {d.rationale}</span>}
                {d.note && <span className="hint"> ({d.note})</span>}
                <span className="log-time mono">{fmtTime(d.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      </div>

      <div id="panel-manual" role="tabpanel" aria-labelledby="tab-manual" hidden={activeTab !== "manual"}>
      <Panel title="⑤ 수동 거래" subtitle="AI 추천을 참고하거나 직접 방향·배수·비중을 골라 스스로 진입/청산합니다. 실제 투자 조언이 아니며 실제 거래는 없습니다.">
        <div className="disclaimer">
          <WarningIcon />
          <span>이 섹션은 재미를 위한 시뮬레이션입니다. 여기서 연 포지션도 ④ 자동매매 탭의 보유 목록·잔고·거래 내역에 함께 표시됩니다.</span>
        </div>

        {wallet && (
          <p className="hint">
            가용 자금: {fmtKrw(Math.round(wallet.available))} KRW (④ 탭과 잔고를 공유합니다)
          </p>
        )}

        <div className="apikey-box">
          {apiKeySaved ? (
            <>
              <span className="hint">내 OpenAI API 키가 이 브라우저에만 저장되어 있습니다(서버 전송 없음).</span>
              <button className="btn ghost" onClick={clearApiKey}>
                키 삭제
              </button>
            </>
          ) : (
            <>
              <label htmlFor="openai-key-input" className="sr-only">
                OpenAI API 키 (선택, 내 브라우저에만 저장됨)
              </label>
              <input
                id="openai-key-input"
                type="password"
                autoComplete="off"
                placeholder="OpenAI API 키 (sk-... , 내 브라우저에만 저장됨)"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
              />
              <button className="btn ghost" onClick={saveApiKey}>
                저장
              </button>
              <span className="hint">키 없이도 규칙 기반 추천으로 사용 가능합니다.</span>
            </>
          )}
        </div>

        <h3 className="subhead">직접 진입용 비중·손절 설정</h3>
        <div className="manual-entry">
          <label htmlFor="manual-pct">가용 자금 대비 비중: {manualPct}%</label>
          <input
            id="manual-pct"
            type="range"
            min={10}
            max={100}
            step={5}
            value={manualPct}
            onChange={(e) => setManualPct(Number(e.target.value))}
            className="pct-slider"
          />
          <label htmlFor="manual-stoploss" className="sr-only">
            손절 퍼센트 (선택)
          </label>
          <input
            id="manual-stoploss"
            type="number"
            min={1}
            max={90}
            placeholder="손절 % (선택, 예: 10)"
            value={manualStopLoss}
            onChange={(e) => setManualStopLoss(e.target.value)}
            className="stoploss-input"
          />
        </div>
        {wallet && (
          <p className="hint">
            직접 진입 규모: 약 {fmtKrw(Math.round(wallet.available * (manualPct / 100)))} KRW
            {manualStopLoss.trim() && ` · 손실 ${manualStopLoss}% 도달 시 자동 청산`}
          </p>
        )}

        <div className="demo-toolbar">
          <button className="btn primary" onClick={requestAdvice} disabled={adviceLoading}>
            {adviceLoading ? "추천 받는 중…" : "AI 추천 받기"}
          </button>
        </div>
        {adviceMsg && <p className="empty">{adviceMsg}</p>}
        {advice && (
          <div className="advice-grid">
            {advice.map((a, i) => (
              <div key={i} className="advice-card">
                <div className={`advice-dir ${a.direction}`}>{a.direction === "long" ? "롱" : "숏"} × {a.leverage}</div>
                <p className="advice-meta">
                  비중 {a.pct}% · 손절 -{a.stopLossPct}% · 신뢰도 {a.confidence}%
                </p>
                <p>{a.rationale}</p>
                <button
                  className="btn success"
                  onClick={() => enterPosition(a.direction, a.leverage, a.rationale, a.pct, a.stopLossPct, a.confidence)}
                  disabled={simBusy !== null}
                >
                  이 추천안(비중 {a.pct}%)으로 진입
                </button>
              </div>
            ))}
            {adviceSource && adviceSource !== "openai" && <p className="hint">(규칙 기반 추천을 사용했습니다.)</p>}
          </div>
        )}

        <h3 className="subhead">직접 진입</h3>
        <div className="manual-entry">
          <label htmlFor="manual-direction" className="sr-only">
            방향
          </label>
          <select
            id="manual-direction"
            value={manualDirection}
            onChange={(e) => setManualDirection(e.target.value as "long" | "short")}
          >
            <option value="long">롱(상승 베팅)</option>
            <option value="short">숏(하락 베팅)</option>
          </select>
          <label htmlFor="manual-leverage" className="sr-only">
            레버리지
          </label>
          <select id="manual-leverage" value={manualLeverage} onChange={(e) => setManualLeverage(Number(e.target.value))}>
            {LEVERAGE_CHOICES.map((l) => (
              <option key={l} value={l}>
                {l}배
              </option>
            ))}
          </select>
          <button
            className="btn"
            onClick={() => enterPosition(manualDirection, manualLeverage, "직접 진입")}
            disabled={simBusy !== null}
          >
            직접 진입
          </button>
        </div>

      </Panel>
      </div>

      <div id="panel-demo" role="tabpanel" aria-labelledby="tab-demo" hidden={activeTab !== "demo"}>
      <Panel
        title="⑥ 합성 재생 데모 (채점용)"
        subtitle="아래 버튼은 합성 시험값만 사용합니다. 실제 정보판 데이터와 분리되어 있습니다."
      >
        <div className="demo-toolbar">
          <button className="btn ghost" onClick={resetDemo} disabled={demoBusy !== null}>
            {demoBusy === "reset" ? "초기화 중…" : "초기화(reset)"}
          </button>
          {FIXTURE_BUTTONS.map((f) => (
            <button
              key={f.id}
              className={`btn ${f.kind}`}
              onClick={() => runFixture(f.id)}
              disabled={demoBusy !== null}
            >
              {demoBusy === f.id ? "재생 중…" : f.label}
            </button>
          ))}
        </div>

        <div className="live-card">
          <div className="live-value-row">
            <div>
              <div className="live-value">
                {demo?.rows?.length
                  ? demo.rows[demo.rows.length - 1].normalized_value.toLocaleString("ko-KR")
                  : "—"}
                <span className="unit">{demo?.rows?.length ? demo.rows[demo.rows.length - 1].unit : ""}</span>
              </div>
              <div className="hint">마지막 재생: {lastFixture ?? "없음"}</div>
            </div>
            <StatusBadge status={demo?.status ?? null} />
          </div>
        </div>

        <h3 className="subhead">데모 일별 기록</h3>
        <DailyTable rows={demo?.rows ?? []} />
      </Panel>
      </div>

      <footer className="footer">
        <a href="/api/receipts">제출정보.json (과정영수증) 보기</a>
      </footer>
    </main>
  );
}
