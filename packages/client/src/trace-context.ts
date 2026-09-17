/** 每次请求建立独立客户端关联上下文；服务端继续同一 Trace。 */
export function traceparent(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const traceId = [...bytes.slice(0, 16)].map((value) => value.toString(16).padStart(2, "0")).join("");
  const spanId = [...bytes.slice(16)].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `00-${traceId}-${spanId}-01`;
}
