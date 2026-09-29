import { NextResponse } from "next/server";
import { listReceipts } from "@/lib/db";
import { LIVE_SIGNAL_ID } from "@/lib/signal";

export const dynamic = "force-dynamic";

// 제출정보.json 형태로 봉인 영수증(과정영수증[])을 내려준다. T04-C22~C24 대조용.
export async function GET() {
  const receipts = await listReceipts(LIVE_SIGNAL_ID);
  const 과정영수증 = receipts.map((r) => ({
    canonical_kind: r.canonical_kind,
    server_created_at: r.server_created_at,
    payload: {
      source_url: r.source_url,
      source_observed_at: r.source_observed_at,
      normalized_value: r.normalized_value,
      unit: r.unit,
    },
    record_date_kst: r.record_date,
  }));

  return NextResponse.json(
    { schema: "aleph-t04-submission-info-v1", signal_id: LIVE_SIGNAL_ID, 과정영수증 },
    {
      headers: {
        "Content-Disposition": "inline; filename=submission-info.json; filename*=UTF-8''%EC%A0%9C%EC%B6%9C%EC%A0%95%EB%B3%B4.json",
      },
    }
  );
}
