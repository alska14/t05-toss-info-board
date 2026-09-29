import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "오늘의 진짜 정보판 — 데이터가 안 올 때",
  description: "비트코인 KRW 시세를 실시간으로 보여주고, 오류 시 값을 지어내지 않고 정직하게 상태를 표시하는 정보판",
  manifest: "/manifest.json",
  openGraph: {
    title: "오늘의 진짜 정보판",
    description: "데이터가 안 올 때, 값을 지어내지 않고 정직하게 보여줍니다.",
    type: "website",
    locale: "ko_KR",
  },
  twitter: {
    card: "summary",
    title: "오늘의 진짜 정보판",
    description: "데이터가 안 올 때, 값을 지어내지 않고 정직하게 보여줍니다.",
  },
};

export const viewport = {
  themeColor: "#0f172a",
};

// 새로고침 시 테마가 잠깐 깜빡이지 않도록, 하이드레이션 전에 동기적으로 data-theme을 세팅한다.
const themeInitScript = `
(function () {
  try {
    var saved = localStorage.getItem("t04-theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ko"
      className={`${inter.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
