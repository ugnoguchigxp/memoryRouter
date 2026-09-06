import type { ContextPackItem } from "../../shared/schemas/context-pack.schema.js";

/**
 * 空白文字に該当するUnicodeコードポイントであるかを判定します。
 */
export function isWhitespaceCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x20 ||
    codePoint === 0x00a0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000 ||
    codePoint === 0xfeff
  );
}

/**
 * CJK文字（日本語・中国語・韓国語など）のUnicodeコードポイントであるかを判定します。
 */
export function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // 平仮名・片仮名
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) || // 片仮名拡張
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK統合漢字拡張A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK統合漢字
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK互換漢字
    (codePoint >= 0xff61 && codePoint <= 0xff9f) || // 半角カタカナ
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // ハングル音節
    (codePoint >= 0x3130 && codePoint <= 0x318f) // ハングル互換文字
  );
}

/**
 * 1文字あたりのトークン重量（比重）を推定します。
 */
export function estimatedTokenWeight(char: string): number {
  const codePoint = char.codePointAt(0);
  if (!codePoint) return 0;
  if (isWhitespaceCodePoint(codePoint)) return 0.15;
  if (codePoint <= 0x7f) return 0.25; // ASCII文字
  if (isCjkCodePoint(codePoint)) return 0.8; // 日本語等のCJK文字
  if (codePoint > 0xffff) return 1; // サロゲートペア領域など
  return 0.5;
}

/**
 * テキスト全体の推定トークン数を算出します。
 */
export function estimateTokens(text: string): number {
  let total = 0;
  for (const char of text) {
    total += estimatedTokenWeight(char);
  }
  return Math.max(1, Math.ceil(total));
}

/**
 * 指定されたトークン予算内に収まるよう、文字列を末尾切り捨て（トリミング）します。
 */
export function truncateForBudget(content: string, maxTokens: number): string {
  if (!content.trim()) return content;
  if (maxTokens <= 0) return "...";
  if (estimateTokens(content) <= maxTokens) return content;
  const suffix = "...";
  const suffixTokens = estimateTokens(suffix);
  const maxContentTokens = Math.max(1, maxTokens - suffixTokens);
  const selectedChars: string[] = [];
  let usedTokens = 0;
  for (const char of content) {
    const tokenCost = estimatedTokenWeight(char);
    if (usedTokens + tokenCost > maxContentTokens) break;
    selectedChars.push(char);
    usedTokens += tokenCost;
  }
  if (selectedChars.length === 0) return suffix;
  while (
    selectedChars.length > 0 &&
    estimateTokens(`${selectedChars.join("")}${suffix}`) > maxTokens
  ) {
    selectedChars.pop();
  }
  if (selectedChars.length === 0) return suffix;
  return `${selectedChars.join("")}${suffix}`;
}

/**
 * 与えられたセクション用アイテム群に対し、トークン予算制限を適用します。
 * 予算オーバー時は、溢れる最初のアイテムをトリミングして上限内に収め、残りのアイテムをドロップします。
 */
export function applySectionTokenBudget(
  items: ContextPackItem[],
  maxTokens: number,
): { items: ContextPackItem[]; dropped: boolean } {
  if (items.length === 0 || maxTokens <= 0) {
    return { items: [], dropped: items.length > 0 };
  }
  const selected: ContextPackItem[] = [];
  let usedTokens = 0;
  for (const item of items) {
    const itemCost = estimateTokens(`${item.title}\n${item.content}\n${item.rankingReason}`);
    if (usedTokens + itemCost <= maxTokens) {
      selected.push(item);
      usedTokens += itemCost;
      continue;
    }
    if (selected.length === 0) {
      const itemOverhead = estimateTokens(`${item.title}\n\n${item.rankingReason}`);
      const contentBudget = maxTokens - itemOverhead;
      if (contentBudget > 0) {
        const content = truncateForBudget(item.content, contentBudget);
        const truncated = { ...item, content };
        if (
          estimateTokens(`${truncated.title}\n${truncated.content}\n${truncated.rankingReason}`) <=
          maxTokens
        ) {
          selected.push(truncated);
        }
      }
    }
    break;
  }
  return { items: selected, dropped: selected.length < items.length };
}
