import { NextResponse } from "next/server";
import {
  closePosition,
  getRecentPerformanceSummary,
  getSimSettings,
  getWalletBalance,
  listOpenPositions,
  logDecision,
  openPosition,
  recordAutoRun,
} from "@/lib/db";
import { fetchMarketSnapshot } from "@/lib/coingecko";
import { getEntryRecommendations, getExitDecisions } from "@/lib/aiTrader";
import { buildOutcomeNote, isLiquidated, pnlAmount, pnlPct, stopLossHit } from "@/lib/sim";

export const dynamic = "force-dynamic";

// 외부 무료 크론(cron-job.org 등)이 5분마다 이 주소를 두드린다.
// x-cron-secret 헤더가 CRON_SECRET과 일치하지 않으면 누구도 실행시킬 수 없다.
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("x-cron-secret") === secret;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const settings = await getSimSettings();
  if (!settings.auto_trading_enabled) {
    return NextResponse.json({ ok: true, skipped: "auto_trading_disabled" });
  }

  const snapshot = await fetchMarketSnapshot();
  if (!snapshot) {
    return NextResponse.json({ ok: true, skipped: "price_unavailable" });
  }

  const performanceSummary = await getRecentPerformanceSummary(15);
  const actions: string[] = [];

  // 1) 청산가·손절선 안전장치부터 확인 (AI 판단보다 우선)
  const open = await listOpenPositions();
  const stillOpen = [];
  for (const pos of open) {
    if (isLiquidated(pos.direction, pos.entry_price, pos.leverage, snapshot.price)) {
      const note = buildOutcomeNote(pos.direction, pos.entry_price, snapshot.price, pos.leverage, "liquidation");
      await closePosition(pos.id, snapshot.price, "liquidation", 0, null, null, note);
      await logDecision({ kind: "liquidation", positionId: pos.id, note });
      actions.push(`#${pos.id} 강제청산(가격 ${snapshot.price.toFixed(0)})`);
      continue;
    }
    const pct = pnlPct(pos.direction, pos.entry_price, pos.leverage, snapshot.price);
    if (stopLossHit(pos.stop_loss_pct, pct)) {
      const amount = pnlAmount(pos.virtual_size, pct);
      const note = buildOutcomeNote(pos.direction, pos.entry_price, snapshot.price, pos.leverage, "stop_loss");
      await closePosition(pos.id, snapshot.price, "stop_loss", Math.max(0, pos.virtual_size + amount), null, null, note);
      await logDecision({ kind: "stop_loss", positionId: pos.id, note });
      actions.push(`#${pos.id} 손절 종료(${pct.toFixed(1)}%)`);
      continue;
    }
    stillOpen.push(pos);
  }

  // 2) 보유 포지션 매도 신뢰도 판단
  if (stillOpen.length > 0) {
    const decisions = await getExitDecisions(
      stillOpen,
      snapshot,
      (pos) => pnlPct(pos.direction, pos.entry_price, pos.leverage, snapshot.price),
      performanceSummary
    );
    if (decisions) {
      for (const d of decisions) {
        const pos = stillOpen.find((p) => p.id === d.id);
        if (!pos) continue;
        if (d.confidence < settings.confidence_threshold) {
          await logDecision({
            kind: "exit_skip",
            positionId: pos.id,
            confidence: d.confidence,
            rationale: d.rationale,
            note: `기준(${settings.confidence_threshold}%) 미달로 보류`,
          });
          continue;
        }
        const pct = pnlPct(pos.direction, pos.entry_price, pos.leverage, snapshot.price);
        const amount = pnlAmount(pos.virtual_size, pct);
        const note = buildOutcomeNote(pos.direction, pos.entry_price, snapshot.price, pos.leverage, "ai_auto");
        await closePosition(
          pos.id,
          snapshot.price,
          "ai_auto",
          Math.max(0, pos.virtual_size + amount),
          d.confidence,
          d.rationale,
          note
        );
        await logDecision({ kind: "exit", positionId: pos.id, confidence: d.confidence, rationale: d.rationale, note });
        actions.push(`#${pos.id} AI 자동매도(신뢰도 ${d.confidence}%): ${d.rationale}`);
      }
    }
  }

  // 3) 신규 진입 판단 — AI가 매번 최대 3개 추천안을 주므로, 신뢰도 기준을 넘는 것부터
  //    순서대로 "동시 보유 한도"까지 여러 건을 한 주기에 열 수 있다.
  let openSlots = Math.max(0, settings.max_concurrent_positions - stillOpen.length);
  if (openSlots > 0) {
    const options = await getEntryRecommendations(snapshot, performanceSummary);
    if (options && options.length) {
      const qualifying = options
        .filter((o) => o.confidence >= settings.confidence_threshold)
        .sort((a, b) => b.confidence - a.confidence);
      const rejected = options.filter((o) => o.confidence < settings.confidence_threshold);

      for (const o of rejected) {
        await logDecision({
          kind: "entry_skip",
          confidence: o.confidence,
          rationale: o.rationale,
          note: `기준(${settings.confidence_threshold}%) 미달로 보류`,
        });
      }

      for (const best of qualifying) {
        if (openSlots <= 0) {
          await logDecision({
            kind: "entry_skip",
            confidence: best.confidence,
            rationale: best.rationale,
            note: `동시 보유 한도(${settings.max_concurrent_positions}건) 도달로 보류`,
          });
          continue;
        }
        const available = await getWalletBalance();
        const usedPct = Math.min(best.pct, settings.max_allocation_pct);
        const virtualSize = Math.floor(available * (usedPct / 100));
        if (virtualSize <= 0) {
          await logDecision({
            kind: "entry_skip",
            confidence: best.confidence,
            rationale: best.rationale,
            note: "가용 자금 부족으로 보류",
          });
          continue;
        }
        const position = await openPosition(
          best.direction,
          best.leverage,
          snapshot.price,
          best.rationale,
          virtualSize,
          best.stopLossPct,
          best.confidence,
          "ai_auto"
        );
        openSlots -= 1;
        await logDecision({
          kind: "entry",
          positionId: position.id,
          confidence: best.confidence,
          rationale: best.rationale,
          note: `${best.direction === "long" ? "롱" : "숏"}×${best.leverage}, 비중 ${usedPct}%(AI 제안 ${best.pct}%, 상한 ${settings.max_allocation_pct}%), 손절 -${best.stopLossPct}%`,
        });
        actions.push(
          `#${position.id} AI 자동진입 ${best.direction === "long" ? "롱" : "숏"}×${best.leverage} 비중${usedPct}% 손절-${best.stopLossPct}% (신뢰도 ${best.confidence}%): ${best.rationale}`
        );
      }
    }
  } else if (stillOpen.length > 0) {
    await logDecision({
      kind: "entry_skip",
      note: `동시 보유 한도(${settings.max_concurrent_positions}건) 이미 도달`,
    });
  }

  const summary = actions.length ? actions.join(" | ") : "이번 주기엔 조건을 만족한 거래 없음";
  await recordAutoRun(summary);

  return NextResponse.json({ ok: true, summary, actions });
}

// 헬스체크/디버깅용 — 수동으로 GET 열어도 설정만 보여주고 실행은 안 한다.
export async function GET() {
  const settings = await getSimSettings();
  return NextResponse.json({ ok: true, settings });
}
