import { NextResponse } from "next/server";
import { resetSimData } from "@/lib/db";

export const dynamic = "force-dynamic";

// 시뮬레이터 포지션·거래내역·로그·잔고만 초기화한다. 라이브 정보판/채점 데모는 건드리지 않는다.
export async function POST() {
  await resetSimData();
  return NextResponse.json({ ok: true });
}
