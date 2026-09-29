import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface NewsItem {
  title: string;
  link: string;
  source: string;
  pubDate: string;
}

let cache: { items: NewsItem[]; expiresAt: number } | null = null;

function extractTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!match) return "";
  return match[1]
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .trim();
}

export async function GET() {
  if (cache && cache.expiresAt > Date.now()) {
    return NextResponse.json({ ok: true, items: cache.items });
  }

  try {
    const res = await fetch(
      "https://news.google.com/rss/search?q=bitcoin&hl=ko&gl=KR&ceid=KR:ko",
      { signal: AbortSignal.timeout(6000), cache: "no-store" }
    );
    if (!res.ok) {
      return NextResponse.json({ ok: true, items: cache?.items ?? [] });
    }
    const xml = await res.text();
    const items: NewsItem[] = [];
    const blocks = xml.split("<item>").slice(1);
    for (const raw of blocks.slice(0, 8)) {
      const rawTitle = extractTag(raw, "title");
      const link = extractTag(raw, "link");
      const pubDate = extractTag(raw, "pubDate");
      const source = extractTag(raw, "source");
      if (!rawTitle || !link) continue;
      items.push({ title: rawTitle, link, source: source || "Google 뉴스", pubDate });
    }
    cache = { items, expiresAt: Date.now() + 5 * 60_000 };
    return NextResponse.json({ ok: true, items });
  } catch {
    return NextResponse.json({ ok: true, items: cache?.items ?? [] });
  }
}
