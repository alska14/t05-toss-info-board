import { NextResponse } from "next/server";
import { getRecentPerformanceSummary } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const summary = await getRecentPerformanceSummary(15);
  return NextResponse.json({ ok: true, summary });
}
