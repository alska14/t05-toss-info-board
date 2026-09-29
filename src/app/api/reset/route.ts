import { NextResponse } from "next/server";
import { resetSignal } from "@/lib/db";
import { DEMO_SIGNAL_ID } from "@/lib/fixtures";

export const dynamic = "force-dynamic";

// 합성 재생 데모 상태만 초기화한다. 실제 정보판(라이브) 데이터·영수증은 건드리지 않는다.
export async function POST() {
  await resetSignal(DEMO_SIGNAL_ID);
  return NextResponse.json({ ok: true });
}
