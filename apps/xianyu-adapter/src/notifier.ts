type FeishuConfig = { appId: string; appSecret: string; chatId: string };

function firstEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function config(): FeishuConfig | undefined {
  const appId = firstEnv("UMA_XIANYU_FEISHU_APP_ID", "AIKB_FEISHU_APP_ID", "FEISHU_APP_ID");
  const appSecret = firstEnv("UMA_XIANYU_FEISHU_APP_SECRET", "AIKB_FEISHU_APP_SECRET", "FEISHU_APP_SECRET");
  const chatId = firstEnv("UMA_XIANYU_FEISHU_CHAT_ID", "AIKB_FEISHU_CHAT_ID", "FEISHU_CHAT_ID");
  return appId && appSecret && chatId ? { appId, appSecret, chatId } : undefined;
}

export class XianyuNotifier {
  private readonly feishu = config();
  private tenantToken: { value: string; expiresAt: number } | undefined;
  private missingLogged = false;

  constructor(
    private readonly logger: { warn(message: string): void; error(message: string, error: unknown): void } = {
      warn: () => undefined,
      error: () => undefined,
    },
  ) {}

  async authExpired(message: string): Promise<void> {
    if (!this.feishu) {
      if (!this.missingLogged) {
        this.missingLogged = true;
        this.logger.warn("Xianyu Feishu alert is not configured");
      }
      return;
    }
    try {
      const token = await this.getTenantToken();
      const response = await fetch(
        "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            receive_id: this.feishu.chatId,
            msg_type: "text",
            content: JSON.stringify({ text: message }),
          }),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { code?: number; msg?: string };
      if (payload.code && payload.code !== 0) throw new Error(payload.msg || `code ${payload.code}`);
    } catch (error) {
      this.logger.error("Xianyu Feishu alert failed", error instanceof Error ? error.message : String(error));
    }
  }

  private async getTenantToken(): Promise<string> {
    if (!this.feishu) throw new Error("Feishu is not configured");
    if (this.tenantToken && this.tenantToken.expiresAt > Date.now() + 60_000) return this.tenantToken.value;
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.feishu.appId, app_secret: this.feishu.appSecret }),
    });
    if (!response.ok) throw new Error(`token HTTP ${response.status}`);
    const payload = (await response.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (payload.code && payload.code !== 0) throw new Error(payload.msg || `token code ${payload.code}`);
    if (!payload.tenant_access_token) throw new Error("Feishu token response is missing tenant_access_token");
    this.tenantToken = {
      value: payload.tenant_access_token,
      expiresAt: Date.now() + Math.max(60, Number(payload.expire ?? 3600)) * 1000,
    };
    return payload.tenant_access_token;
  }
}
