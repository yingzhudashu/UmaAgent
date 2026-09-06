import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as QRCode from "qrcode";
import { XianyuAuthError, XianyuProtocolError } from "./client.js";

const execFile = promisify(execFileCallback);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36";
const PASSPORT_HEADERS = {
  "user-agent": UA,
  accept: "application/json, text/plain, */*",
  "accept-language": "zh-CN,zh;q=0.9",
};
const MTOP_HEADERS = {
  "user-agent": UA,
  accept: "application/json",
  origin: "https://www.goofish.com",
  referer: "https://www.goofish.com/",
  "content-type": "application/x-www-form-urlencoded",
};
const PASSPORT = "https://passport.goofish.com";

export type XianyuLoginStatus =
  | "pending_login"
  | "waiting_scan"
  | "scanned"
  | "confirmed"
  | "expired"
  | "authenticated"
  | "failed";

export interface XianyuLoginSnapshot {
  status: XianyuLoginStatus;
  message?: string;
  qrUrl?: string;
  qrDataUrl?: string;
  expiresAt?: number;
  updatedAt: number;
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    const value = response.headers.get("set-cookie") ?? "";
    for (const part of value.split(/,(?=[^;=]+=[^;]+)/)) {
      const pair = part.split(";", 1)[0]?.trim() ?? "";
      const [name, ...rest] = pair.split("=");
      if (name && rest.length) this.cookies.set(name, rest.join("="));
    }
  }

  get(name: string): string {
    return this.cookies.get(name) ?? "";
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  filteredHeader(): string {
    return this.header();
  }
}

class LoginHttp {
  private readonly jar = new CookieJar();

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cookie", this.jar.header());
    const response = await fetch(url, { ...init, headers, redirect: "follow" });
    this.jar.absorb(response);
    return response;
  }

  cookie(name: string): string {
    return this.jar.get(name);
  }

  setCookie(name: string, value: string): void {
    this.jar.set(name, value);
  }

  cookieHeader(): string {
    return this.jar.filteredHeader();
  }
}

function nestedData(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new XianyuProtocolError("闲鱼登录接口返回了非对象 JSON");
  const content = (payload as Record<string, unknown>).content;
  const data = content && typeof content === "object" ? (content as Record<string, unknown>).data : undefined;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new XianyuProtocolError("闲鱼登录接口响应缺少 content.data");
  return data as Record<string, unknown>;
}

async function generateTfstk(): Promise<string> {
  const script = fileURLToPath(new URL("./resources/gen_tfstk.js", import.meta.url));
  const result = await execFile(process.execPath, [script], {
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  const value = result.stdout.trim();
  if (!value) throw new XianyuProtocolError("生成闲鱼登录环境令牌失败");
  return value;
}

async function prepareQrSession(http: LoginHttp): Promise<{
  common: Record<string, string>;
  cna: string;
  qrUrl: string;
  qrT: string;
  qrCk: string;
}> {
  await http.request("https://log.mmstat.com/eg.js");
  const cna = http.cookie("cna");
  for (const api of [
    "mtop.taobao.idlehome.home.webpc.feed",
    "mtop.gaia.nodejs.gaia.idle.data.gw.v2.index.get",
  ]) {
    const params = new URLSearchParams({
      jsv: "2.7.2",
      appKey: "34839810",
      t: String(Date.now()),
      sign: "",
      v: "1.0",
      type: "originaljson",
      dataType: "json",
      timeout: "20000",
      api,
      sessionOption: "AutoLoginOnly",
      spm_cnt: "a21ybx.home.0.0",
    });
    await http.request(`https://h5api.m.goofish.com/h5/${api}/1.0/?${params}`, {
      method: "POST",
      headers: MTOP_HEADERS,
      body: "data=%7B%7D",
    });
  }
  http.setCookie("tfstk", await generateTfstk());
  await http.request(
    `${PASSPORT}/mini_login.htm?${new URLSearchParams({
      lang: "zh_cn",
      appName: "xianyu",
      appEntrance: "web",
      styleType: "vertical",
      bizParams: "",
      notLoadSsoView: "false",
      notKeepLogin: "false",
      isMobile: "false",
      qrCodeFirst: "false",
      stie: "77",
    })}`,
    { headers: { ...PASSPORT_HEADERS, referer: "https://www.goofish.com/" } },
  );
  const common = {
    appName: "xianyu",
    fromSite: "77",
    appEntrance: "web",
    _csrf_token: http.cookie("XSRF-TOKEN"),
    umidToken: "",
    hsiz: http.cookie("cookie2"),
    bizParams: `taobaoBizLoginFrom=web&renderRefer=${encodeURIComponent("https://www.goofish.com/")}`,
    mainPage: "false",
    isMobile: "false",
    lang: "zh_CN",
    returnUrl: "",
    umidTag: "SERVER",
  };
  const response = await http.request(
    `${PASSPORT}/newlogin/qrcode/generate.do?${new URLSearchParams(common)}`,
    {
      headers: { ...PASSPORT_HEADERS, referer: `${PASSPORT}/mini_login.htm` },
    },
  );
  if (!response.ok) throw new XianyuProtocolError(`闲鱼二维码生成失败: HTTP ${response.status}`);
  const generated = nestedData(await response.json());
  const qrUrl = String(generated.codeContent ?? "");
  const qrT = String(generated.t ?? "");
  const qrCk = String(generated.ck ?? "");
  if (!qrUrl || !qrT || !qrCk) throw new XianyuProtocolError("闲鱼二维码响应缺少必要字段");
  return { common, cna, qrUrl, qrT, qrCk };
}

async function finishLogin(http: LoginHttp, cna: string, loginToken: string): Promise<string> {
  if (loginToken) {
    const response = await http.request(
      `${PASSPORT}/login_token/login.do?${new URLSearchParams({
        token: loginToken,
        subFlow: "DIALOG_CHECK_LOGIN_RPC",
        nextCode: "0018",
        bizScene: "qrcode",
        confirm: "true",
      })}`,
      {
        method: "POST",
        headers: {
          ...PASSPORT_HEADERS,
          "content-type": "application/x-www-form-urlencoded",
          origin: PASSPORT,
          referer: `${PASSPORT}/mini_login.htm`,
        },
        body: new URLSearchParams({ deviceId: cna }),
      },
    );
    if (!response.ok) throw new XianyuProtocolError(`闲鱼登录确认失败: HTTP ${response.status}`);
  }
  if (!http.cookie("unb")) throw new XianyuAuthError("闲鱼扫码登录未返回登录 Cookie");
  await http.request("https://h5api.m.goofish.com/h5/mtop.idle.web.user.page.nav/1.0/", {
    method: "POST",
    headers: MTOP_HEADERS,
    body: "data=%7B%7D",
  });
  const cookie = http.cookieHeader();
  if (!cookie.includes("unb=") || !cookie.includes("_m_h5_tk="))
    throw new XianyuAuthError("扫码成功，但登录 Cookie 不完整");
  return cookie;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class XianyuLoginController {
  private snapshotValue: XianyuLoginSnapshot;
  private running = false;
  private readonly onAuthenticated: (cookie: string) => Promise<void>;

  constructor(authenticated: boolean, onAuthenticated: (cookie: string) => Promise<void>) {
    this.snapshotValue = {
      status: authenticated ? "authenticated" : "pending_login",
      updatedAt: Date.now(),
    };
    this.onAuthenticated = onAuthenticated;
  }

  snapshot(): XianyuLoginSnapshot {
    return { ...this.snapshotValue };
  }

  markExpired(message = "闲鱼登录已过期，请管理员重新扫码登录"): void {
    this.running = false;
    this.snapshotValue = { status: "expired", message, updatedAt: Date.now() };
  }

  async start(): Promise<XianyuLoginSnapshot> {
    if (this.running) return this.snapshot();
    if (this.snapshotValue.status === "authenticated") return this.snapshot();
    this.running = true;
    try {
      const http = new LoginHttp();
      const prepared = await prepareQrSession(http);
      const expiresAt = Date.now() + 120_000;
      const qrDataUrl = await QRCode.toDataURL(prepared.qrUrl, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 320,
      });
      this.snapshotValue = {
        status: "waiting_scan",
        qrUrl: prepared.qrUrl,
        qrDataUrl,
        expiresAt,
        updatedAt: Date.now(),
      };
      void this.poll(http, prepared, expiresAt);
      return this.snapshot();
    } catch (error) {
      this.running = false;
      this.snapshotValue = {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
      };
      throw error;
    }
  }

  private async poll(
    http: LoginHttp,
    prepared: { common: Record<string, string>; cna: string; qrT: string; qrCk: string },
    expiresAt: number,
  ): Promise<void> {
    try {
      let lastState = "";
      while (Date.now() < expiresAt && this.running) {
        await sleep(3_000);
        const response = await http.request(
          `${PASSPORT}/newlogin/qrcode/query.do?appName=xianyu&fromSite=77`,
          {
            method: "POST",
            headers: {
              ...PASSPORT_HEADERS,
              "content-type": "application/x-www-form-urlencoded",
              origin: PASSPORT,
              referer: `${PASSPORT}/mini_login.htm`,
            },
            body: new URLSearchParams({
              ...prepared.common,
              t: prepared.qrT,
              ck: prepared.qrCk,
              navlanguage: "zh-CN",
              navUserAgent: UA,
              navPlatform: "Win32",
              isIframe: "true",
              documentReferer: "https://www.goofish.com/",
              defaultView: "sms",
              deviceId: prepared.cna,
            }),
          },
        );
        if (!response.ok) throw new XianyuProtocolError(`闲鱼二维码查询失败: HTTP ${response.status}`);
        const data = nestedData(await response.json());
        const state = String(data.qrCodeStatus ?? "");
        if (state && state !== lastState) {
          lastState = state;
          this.snapshotValue = {
            ...this.snapshotValue,
            status: state === "SCANNED" ? "scanned" : state === "CONFIRMED" ? "confirmed" : "waiting_scan",
            updatedAt: Date.now(),
          };
        }
        if (state === "CONFIRMED") {
          const token = String(data.token ?? data.lgToken ?? "");
          const cookie = await finishLogin(http, prepared.cna, token);
          await this.onAuthenticated(cookie);
          this.running = false;
          this.snapshotValue = { status: "authenticated", updatedAt: Date.now() };
          return;
        }
        if (state === "EXPIRED") break;
      }
      this.running = false;
      this.snapshotValue = {
        status: "expired",
        message: "闲鱼登录二维码已过期，请重新生成",
        updatedAt: Date.now(),
      };
    } catch (error) {
      this.running = false;
      this.snapshotValue = {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
      };
    }
  }
}
