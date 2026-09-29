import { NextResponse } from "next/server";
import { fetchMarketSnapshot } from "@/lib/coingecko";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await fetchMarketSnapshot();
  if (!snapshot) {
    return NextResponse.json({ ok: false }, { status: 502 });
  }
  return NextResponse.json({ ok: true, ...snapshot });
}
