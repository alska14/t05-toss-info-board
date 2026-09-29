import { NextResponse } from "next/server";
import { closePosition, listOpenPositions, logDecision } from "@/lib/db";
import { fetchMarketSnapshot } from "@/lib/coingecko";
import { buildOutcomeNote, pnlAmount, pnlPct } from "@/lib/sim";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: number };
  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  }

  const open = await listOpenPositions();
  const pos = open.find((p) => p.id === id);
  if (!pos) {
    return NextResponse.json({ ok: false, error: "no such open position" }, { status: 404 });
  }
  const snapshot = await fetchMarketSnapshot();
  if (!snapshot) {
    return NextResponse.json({ ok: false, error: "price unavailable" }, { status: 502 });
  }
  const pct = pnlPct(pos.direction, pos.entry_price, pos.leverage, snapshot.price);
  const amount = pnlAmount(pos.virtual_size, pct);
  const note = buildOutcomeNote(pos.direction, pos.entry_price, snapshot.price, pos.leverage, "manual");
  await closePosition(id, snapshot.price, "manual", Math.max(0, pos.virtual_size + amount), null, null, note);
  await logDecision({ kind: "manual_close", positionId: id, note });
  return NextResponse.json({ ok: true });
}
