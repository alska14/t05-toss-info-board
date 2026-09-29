import { NextResponse } from "next/server";
import { listDecisionLog } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const log = await listDecisionLog(30);
  return NextResponse.json({ ok: true, log });
}
