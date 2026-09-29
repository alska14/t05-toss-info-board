import { NextResponse } from "next/server";
import { getSimSettings, updateSimSettings } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await getSimSettings();
  return NextResponse.json({ ok: true, settings });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    auto_trading_enabled?: boolean;
    max_allocation_pct?: number;
    confidence_threshold?: number;
    max_concurrent_positions?: number;
  };

  const patch: Parameters<typeof updateSimSettings>[0] = {};
  if (typeof body.auto_trading_enabled === "boolean") patch.auto_trading_enabled = body.auto_trading_enabled;
  if (body.max_allocation_pct != null) {
    const v = Number(body.max_allocation_pct);
    if (!Number.isInteger(v) || v < 1 || v > 100) {
      return NextResponse.json({ ok: false, error: "max_allocation_pct must be 1-100" }, { status: 400 });
    }
    patch.max_allocation_pct = v;
  }
  if (body.confidence_threshold != null) {
    const v = Number(body.confidence_threshold);
    if (!Number.isInteger(v) || v < 1 || v > 100) {
      return NextResponse.json({ ok: false, error: "confidence_threshold must be 1-100" }, { status: 400 });
    }
    patch.confidence_threshold = v;
  }
  if (body.max_concurrent_positions != null) {
    const v = Number(body.max_concurrent_positions);
    if (!Number.isInteger(v) || v < 1 || v > 10) {
      return NextResponse.json({ ok: false, error: "max_concurrent_positions must be 1-10" }, { status: 400 });
    }
    patch.max_concurrent_positions = v;
  }

  const settings = await updateSimSettings(patch);
  return NextResponse.json({ ok: true, settings });
}
