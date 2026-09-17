import { UmaClientError } from "@uma-agent/client";

/** 用户提示只保留服务端公开错误及关联 ID，避免把传输异常直接当成业务结果。 */
export function requestErrorMessage(error: unknown): string {
  if (!(error instanceof UmaClientError)) return "请求未完成，请稍后重试。";
  if (error.code === "provider_error" || error.code === "provider_contract_error")
    return `模型服务暂时不可用${error.requestId ? `（请求 ${error.requestId}）` : ""}。`;
  if (error.code === "forbidden") return "当前账号没有执行此操作的权限。";
  if (error.code === "rate_limited") return "请求过于频繁，请稍后重试。";
  return `${error.message}${error.requestId ? `（请求 ${error.requestId}）` : ""}`;
}
