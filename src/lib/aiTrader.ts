// 서버 사이드 자동매매용 AI 호출. 이 파일이 쓰는 키(OPENAI_API_KEY)는
// Vercel 서버 환경변수에만 있고, 클라이언트 시뮬레이터가 쓰는
// 브라우저 저장 키(사용자 개인 키)와는 완전히 별개다.
import { MarketSnapshot } from "./coingecko";
import { SimPosition } from "./db";

export interface EntryRecommendation {
  direction: "long" | "short";
  leverage: number;
  pct: number;
  stopLossPct: number;
  confidence: number;
  rationale: string;
}

export interface ExitDecision {
  id: number;
  confidence: number;
  rationale: string;
}

async function callOpenAI(system: string, user: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.6,
        max_tokens: 700,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

export async function getEntryRecommendations(
  snapshot: MarketSnapshot,
  performanceSummary?: string
): Promise<EntryRecommendation[] | null> {
  const sparkline = snapshot.sparkline7d;
  const sparkMin = sparkline.length ? Math.min(...sparkline) : 0;
  const sparkMax = sparkline.length ? Math.max(...sparkline) : 0;

  const content = await callOpenAI(
    "당신은 오락용 가상 모의투자 게임의 자동매매 도우미입니다. 실제 금융 조언이 아니고, 참가자는 실제 자금이 아닌 가상 자금으로만 놉니다. " +
      "주어진 시세와 최근 성과 피드백을 참고해 가상 포지션 추천안 정확히 3개를 만드세요. 최근 성과에서 신뢰도를 과신했던 패턴이 보이면 confidence를 더 보수적으로 매기고, " +
      "확신이 낮을수록 pct(비중)를 작게, stopLossPct(손절폭)를 타이트하게 제안하세요. " +
      "각 추천에는 0~100 사이의 confidence, 10~100 사이의 pct(가용자금 대비 비중 %), 1~90 사이의 stopLossPct(손절 기준 %)를 반드시 매기세요. " +
      "rationale은 반드시 두 부분으로 구성하세요: (1) 방향 판단 근거 — 24시간 변동률·7일 구간·현재가 같은 구체적 수치를 최소 1개 인용, " +
      "(2) '신뢰도 N%인 이유' — 왜 그 확신 수준인지(추세 뚜렷함/불확실성/최근 성과 반영 등) 명시. 두 부분을 자연스러운 한 문장으로 이어 총 70~120자 한국어로 쓰세요. " +
      '반드시 {"options":[{"direction":"long|short","leverage":정수(1~10),"pct":정수(10~100),"stopLossPct":정수(1~90),"confidence":정수(0~100),"rationale":"70~120자, 수치 인용 + 신뢰도 근거 포함"}, ...]} 형태의 JSON 객체만 답하세요.',
    `비트코인 현재가 ${snapshot.price.toLocaleString("ko-KR")}KRW, 24시간 변동 ${snapshot.change24hPct.toFixed(2)}%, 7일 구간 ${sparkMin.toFixed(0)}~${sparkMax.toFixed(0)}KRW.` +
      (performanceSummary ? ` 최근 성과 피드백: ${performanceSummary}` : "")
  );
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as { options?: unknown };
    if (!Array.isArray(parsed.options)) return null;
    const out: EntryRecommendation[] = [];
    for (const item of parsed.options.slice(0, 3)) {
      const o = item as Record<string, unknown>;
      if (o.direction !== "long" && o.direction !== "short") continue;
      const leverage = Number(o.leverage);
      const confidence = Number(o.confidence);
      const pct = Number(o.pct);
      const stopLossPct = Number(o.stopLossPct);
      if (!Number.isInteger(leverage) || leverage < 1 || leverage > 10) continue;
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) continue;
      if (!Number.isFinite(pct) || pct < 10 || pct > 100) continue;
      if (!Number.isFinite(stopLossPct) || stopLossPct < 1 || stopLossPct > 90) continue;
      out.push({
        direction: o.direction,
        leverage,
        pct: Math.round(pct),
        stopLossPct: Math.round(stopLossPct),
        confidence,
        rationale: typeof o.rationale === "string" ? o.rationale.slice(0, 220) : "",
      });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

export async function getExitDecisions(
  positions: SimPosition[],
  snapshot: MarketSnapshot,
  pnlPctFor: (pos: SimPosition) => number,
  performanceSummary?: string
): Promise<ExitDecision[] | null> {
  if (positions.length === 0) return [];

  const summary = positions
    .map(
      (p) =>
        `id=${p.id} ${p.direction} ${p.leverage}배 진입가=${p.entry_price.toFixed(0)} 현재손익=${pnlPctFor(p).toFixed(2)}% ` +
        `진입근거="${p.rationale ?? "없음"}" 진입신뢰도=${p.entry_confidence ?? "?"}% 손절기준=${p.stop_loss_pct != null ? `-${p.stop_loss_pct}%` : "없음"}`
    )
    .join(" | ");

  const content = await callOpenAI(
    "당신은 오락용 가상 모의투자 게임의 자동매매 도우미입니다. 실제 금융 조언이 아니고, 가상 자금만 다룹니다. " +
      "아래 보유 중인 각 포지션에 대해 '지금 매도(청산)해야 하는지' 0~100 confidence로 판단하세요. 숫자가 높을수록 지금 매도를 강하게 권합니다. " +
      "최근 성과 피드백에서 손실 패턴이 반복되면 더 적극적으로 매도를 권하세요. " +
      "rationale은 반드시 두 부분을 담으세요: (1) 판단 근거 — 진입 시 근거였던 내용이 여전히 유효한지, 현재 손익률(%)이 왜 매도/보유를 뒷받침하는지 구체적으로, " +
      "(2) '신뢰도 N%인 이유' — 왜 그 확신 수준인지 명시. 한 문장으로 이어 총 70~120자 한국어로 쓰세요. " +
      '반드시 {"decisions":[{"id":포지션id,"confidence":정수(0~100),"rationale":"70~120자, 손익률 인용 + 신뢰도 근거 포함"}, ...]} 형태의 JSON 객체만 답하세요. 모든 포지션에 대해 하나씩 판단하세요.',
    `현재가 ${snapshot.price.toLocaleString("ko-KR")}KRW, 24시간 변동 ${snapshot.change24hPct.toFixed(2)}%. 보유 포지션: ${summary}` +
      (performanceSummary ? ` 최근 성과 피드백: ${performanceSummary}` : "")
  );
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as { decisions?: unknown };
    if (!Array.isArray(parsed.decisions)) return null;
    const out: ExitDecision[] = [];
    for (const item of parsed.decisions) {
      const o = item as Record<string, unknown>;
      const id = Number(o.id);
      const confidence = Number(o.confidence);
      if (!Number.isInteger(id) || !Number.isFinite(confidence) || confidence < 0 || confidence > 100) continue;
      out.push({ id, confidence, rationale: typeof o.rationale === "string" ? o.rationale.slice(0, 220) : "" });
    }
    return out;
  } catch {
    return null;
  }
}
