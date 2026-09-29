export function liquidationPrice(direction: "long" | "short", entryPrice: number, leverage: number): number {
  return direction === "long" ? entryPrice * (1 - 1 / leverage) : entryPrice * (1 + 1 / leverage);
}

export function isLiquidated(
  direction: "long" | "short",
  entryPrice: number,
  leverage: number,
  currentPrice: number
): boolean {
  const liq = liquidationPrice(direction, entryPrice, leverage);
  return direction === "long" ? currentPrice <= liq : currentPrice >= liq;
}

export function pnlPct(direction: "long" | "short", entryPrice: number, leverage: number, currentPrice: number) {
  const raw = direction === "long" ? (currentPrice - entryPrice) / entryPrice : (entryPrice - currentPrice) / entryPrice;
  return raw * leverage * 100;
}

export function pnlAmount(virtualSize: number, pnlPercent: number) {
  return (virtualSize * pnlPercent) / 100;
}

export function stopLossHit(stopLossPct: number | null, currentPnlPct: number): boolean {
  if (stopLossPct == null) return false;
  return currentPnlPct <= -Math.abs(stopLossPct);
}

// 값에서 그대로 계산한, 지어내지 않은 결과 설명. 승패와 무관하게 항상 생성한다.
export function buildOutcomeNote(
  direction: "long" | "short",
  entryPrice: number,
  closePrice: number,
  leverage: number,
  closeReason: string
): string {
  const priceMovePct = ((closePrice - entryPrice) / entryPrice) * 100;
  const won = direction === "long" ? priceMovePct > 0 : priceMovePct < 0;
  const moveDesc = priceMovePct >= 0 ? `+${priceMovePct.toFixed(2)}%` : `${priceMovePct.toFixed(2)}%`;
  const reasonDesc =
    closeReason === "liquidation"
      ? "청산가 도달로 강제 종료"
      : closeReason === "stop_loss"
        ? "설정한 손절선 도달로 자동 종료"
        : closeReason === "ai_auto"
          ? "AI 매도 판단으로 종료"
          : "수동 종료";
  if (won) {
    return `가격이 진입 대비 ${moveDesc} 움직여 ${direction === "long" ? "롱" : "숏"} 방향과 일치(레버리지 ${leverage}배). ${reasonDesc}.`;
  }
  return `가격이 진입 대비 ${moveDesc} 움직여 ${direction === "long" ? "롱" : "숏"} 방향과 반대로 감(레버리지 ${leverage}배로 손실 확대). ${reasonDesc}.`;
}
