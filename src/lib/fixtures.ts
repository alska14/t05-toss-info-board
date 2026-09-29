import authFixture from "@/fixtures/auth-401.json";
import normalD1A from "@/fixtures/normal-d1-a.json";
import normalD1B from "@/fixtures/normal-d1-b.json";
import normalD2 from "@/fixtures/normal-d2.json";
import offlineFixture from "@/fixtures/offline.json";
import rate429 from "@/fixtures/rate-429.json";
import recoverD2 from "@/fixtures/recover-d2.json";
import schemaBreak from "@/fixtures/schema-break.json";
import timeoutFixture from "@/fixtures/timeout.json";
import { NormalizedReading } from "./adapter";

export interface Fixture {
  fixture_id: string;
  contract_version: string;
  description_ko: string;
  virtual_now: string;
  transport: {
    mode: string;
    status: number | null;
    delay_ms: number;
    deadline_ms: number;
    headers: Record<string, string>;
  };
  payload: NormalizedReading | Record<string, unknown> | null;
  expected: Record<string, unknown>;
}

export const FIXTURES: Record<string, Fixture> = {
  "T04-AUTH-401": authFixture as Fixture,
  "T04-NORMAL-D1-A": normalD1A as Fixture,
  "T04-NORMAL-D1-B": normalD1B as Fixture,
  "T04-NORMAL-D2": normalD2 as Fixture,
  "T04-OFFLINE": offlineFixture as Fixture,
  "T04-RATE-429": rate429 as Fixture,
  "T04-RECOVER-D2": recoverD2 as Fixture,
  "T04-SCHEMA-BREAK": schemaBreak as Fixture,
  "T04-TIMEOUT": timeoutFixture as Fixture,
};

export const FIXTURE_ORDER = [
  "T04-NORMAL-D1-A",
  "T04-NORMAL-D1-B",
  "T04-NORMAL-D2",
  "T04-TIMEOUT",
  "T04-AUTH-401",
  "T04-RATE-429",
  "T04-OFFLINE",
  "T04-SCHEMA-BREAK",
  "T04-RECOVER-D2",
] as const;

export const DEMO_SIGNAL_ID = "aleph-demo-index";
