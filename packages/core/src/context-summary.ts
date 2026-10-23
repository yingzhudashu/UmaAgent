/** Old fallback dumps are not summaries and must never hide original dialogue. */
export function isUsableContextSummary(content: string): boolean {
  const text = content.trim();
  return text.length > 0 && !text.startsWith("已有摘要：");
}
