import { NextResponse } from "next/server";
import { closePosition, getWalletBalance, listOpenPositions, listPositionHistory, logDecision } from "@/lib/db";
import { fetchMarketSnapshot } from "@/lib/coingecko";
import { buildOutcomeNote, isLiquidated, liquidationPrice, pnlAmount, pnlPct, stopLossHit } from "@/lib/sim";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await fetchMarketSnapshot();
  const openRaw = await listOpenPositions();

  const stillOpen: (typeof openRaw)[number][] = [];
  if (snapshot) {
    for (const pos of openRaw) {
      if (isLiquidated(pos.direction, pos.entry_price, pos.leverage, snapshot.price)) {
        const note = buildOutcomeNote(pos.direction, pos.entry_price, snapshot.price, pos.leverage, "liquidation");
        await closePosition(pos.id, snapshot.price, "liquidation", 0, null, null, note);
        await logDecision({ kind: "liquidation", positionId: pos.id, note });
        continue;
      }
      const pct = pnlPct(pos.direction, pos.entry_price, pos.leverage, snapshot.price);
      if (stopLossHit(pos.stop_loss_pct, pct)) {
        const amount = pnlAmount(pos.virtual_size, pct);
        const note = buildOutcomeNote(pos.direction, pos.entry_price, snapshot.price, pos.leverage, "stop_loss");
        await closePosition(pos.id, snapshot.price, "stop_loss", Math.max(0, pos.virtual_size + amount), null, null, note);
        await logDecision({ kind: "stop_loss", positionId: pos.id, note });
        continue;
      }
      stillOpen.push(pos);
    }
  } else {
    stillOpen.push(...openRaw);
  }

  const open = stillOpen.map((pos) => {
    if (!snapshot) return pos;
    const pct = pnlPct(pos.direction, pos.entry_price, pos.leverage, snapshot.price);
    return {
      ...pos,
      current_price: snapshot.price,
      liquidation_price: liquidationPrice(pos.direction, pos.entry_price, pos.leverage),
      pnl_pct: pct,
      pnl_amount: pnlAmount(pos.virtual_size, pct),
    };
  });

  const history = await listPositionHistory(20);
  const balance = await getWalletBalance();
  const locked = stillOpen.reduce((sum, p) => sum + p.virtual_size, 0);

  return NextResponse.json({
    ok: true,
    open,
    history,
    price: snapshot?.price ?? null,
    wallet: { available: balance, locked, total: balance + locked },
  });
}
