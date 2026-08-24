import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import QRCode from "qrcode";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36";

/** CLI 专用扫码登录：Cookie 只在内存和用户明确指定的配置文件中出现。 */
export async function xianyuLogin(configPath: string): Promise<void> {
  const session = await fetch("https://passport.goofish.com/newlogin/qrcode/generate.do", {
    headers: { "user-agent": USER_AGENT },
  });
  if (!session.ok) throw new Error(`闲鱼二维码请求失败: HTTP ${session.status}`);
  const payload = (await session.json()) as {
    content?: { data?: { codeContent?: string; t?: string; ck?: string } };
  };
  const data = payload.content?.data;
  if (!data?.codeContent || !data.t || !data.ck) throw new Error("闲鱼二维码响应缺少必要字段");
  const { codeContent, t, ck } = data;
  process.stdout.write(await QRCode.toString(codeContent, { type: "terminal", small: true }));
  process.stdout.write("\n请使用闲鱼 App 扫码并确认。\n");
  const deadline = Date.now() + 120_000;
  let cookie = "";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const response = await fetch(
      `https://passport.goofish.com/newlogin/qrcode/query.do?t=${encodeURIComponent(t)}&ck=${encodeURIComponent(ck)}`,
      { headers: { "user-agent": USER_AGENT } },
    );
    if (!response.ok) throw new Error(`闲鱼二维码轮询失败: HTTP ${response.status}`);
    const value = (await response.json()) as {
      content?: { data?: { qrCodeStatus?: string; token?: string } };
    };
    const state = value.content?.data?.qrCodeStatus;
    if (state === "EXPIRED") throw new Error("闲鱼登录二维码已过期");
    if (state !== "CONFIRMED") continue;
    const token = value.content?.data?.token;
    if (!token) throw new Error("闲鱼登录确认后未返回 token");
    const completed = await fetch(
      `https://passport.goofish.com/login_token/login.do?token=${encodeURIComponent(token)}&confirm=true`,
      { method: "POST", headers: { "user-agent": USER_AGENT } },
    );
    const setCookie = completed.headers.get("set-cookie");
    if (!completed.ok || !setCookie) throw new Error("闲鱼登录未返回 Cookie");
    cookie = setCookie
      .split(/,(?=[^;=]+=[^;]+)/)
      .map((item) => item.split(";", 1)[0])
      .join("; ");
    break;
  }
  if (!cookie) throw new Error("闲鱼扫码登录超时");
  const current = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  if (!current.xianyu || typeof current.xianyu !== "object" || Array.isArray(current.xianyu))
    throw new Error("用户配置缺少 xianyu 对象");
  (current.xianyu as Record<string, unknown>).cookie = cookie;
  const temporary = join(dirname(configPath), `.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, configPath);
  process.stdout.write(`闲鱼 Cookie 已写入 ${configPath}\n`);
}
