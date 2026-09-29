import { NextResponse } from "next/server";
import { ErrorCode, NormalizedReading } from "@/lib/adapter";
import { applyError, applySuccessfulReading, getStatus, listDailyRows } from "@/lib/db";
import { DEMO_SIGNAL_ID, FIXTURES } from "@/lib/fixtures";

export const dynamic = "force-dynamic";

async function currentState() {
  const [rows, status] = await Promise.all([listDailyRows(DEMO_SIGNAL_ID), getStatus(DEMO_SIGNAL_ID)]);
  return { rows, status };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { fixture_id?: string };
  const fixture = body.fixture_id ? FIXTURES[body.fixture_id] : undefined;
  if (!fixture) {
    return NextResponse.json({ ok: false, error: "unknown fixture_id" }, { status: 400 });
  }

  const meta = {
    fixture_id: fixture.fixture_id,
    virtual_now: fixture.virtual_now,
    retry_after_seconds: fixture.transport.headers["retry-after"]
      ? Number(fixture.transport.headers["retry-after"])
      : null,
  };

  const t = fixture.transport;

  if (t.mode === "timeout") {
    await applyError(DEMO_SIGNAL_ID, "timeout", meta);
  } else if (t.mode === "offline") {
    await applyError(DEMO_SIGNAL_ID, "offline", meta);
  } else if (t.status === 401 || t.status === 403) {
    await applyError(DEMO_SIGNAL_ID, "auth", meta);
  } else if (t.status === 429) {
    await applyError(DEMO_SIGNAL_ID, "rate_limit", meta);
  } else if (t.status && t.status >= 200 && t.status < 300 && fixture.payload) {
    await applySuccessfulReading(fixture.payload as NormalizedReading, meta);
  } else {
    await applyError(DEMO_SIGNAL_ID, "schema_error" as ErrorCode, meta);
  }

  const state = await currentState();
  return NextResponse.json({ ok: true, fixture_id: fixture.fixture_id, ...state });
}

export async function GET() {
  const state = await currentState();
  return NextResponse.json({ ok: true, ...state });
}
