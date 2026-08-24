import { createHash, randomUUID } from "node:crypto";
import { decode as decodeMsgpack } from "@msgpack/msgpack";
import type { XianyuInboundMessage } from "./adapter.js";

export const APP_KEY = "34839810";
export const IM_APP_KEY = "444e9908a51d1cb236a27862abc769c9";

export function parseCookieHeader(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of value.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name && rest.length) result[name] = rest.join("=");
  }
  return result;
}

export function formatCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

export function mtopSign(timestampMs: string | number, token: string, data: string): string {
  return createHash("md5").update(`${token}&${timestampMs}&${APP_KEY}&${data}`).digest("hex");
}

export function generateMid(): string {
  return `${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0")}${Date.now()} 0`;
}

export function generateDeviceId(ownerId: string): string {
  return `${randomUUID().toUpperCase()}-${ownerId}`;
}

export function buildAck(frame: Record<string, unknown>): Record<string, unknown> {
  const headers =
    frame.headers && typeof frame.headers === "object" ? (frame.headers as Record<string, unknown>) : {};
  const ackHeaders: Record<string, unknown> = {
    mid: String(headers.mid ?? generateMid()),
    sid: String(headers.sid ?? ""),
  };
  for (const key of ["app-key", "ua", "dt"]) if (key in headers) ackHeaders[key] = headers[key];
  return { code: 200, headers: ackHeaders };
}

export function buildRegistration(accessToken: string, deviceId: string): Record<string, unknown> {
  return {
    lwp: "/reg",
    headers: {
      "cache-header": "app-key token ua wv",
      "app-key": IM_APP_KEY,
      token: accessToken,
      ua: "Mozilla/5.0 DingTalk(2.1.5) OS(Windows/10) DingWeb/2.1.5",
      dt: "j",
      wv: "im:3,au:3,sy:6",
      sync: "0,0;0;0;",
      did: deviceId,
      mid: generateMid(),
    },
  };
}

export function buildSyncAck(): Record<string, unknown> {
  const now = Date.now();
  return {
    lwp: "/r/SyncStatus/ackDiff",
    headers: { mid: generateMid() },
    body: [
      {
        pipeline: "sync",
        tooLong2Tag: "PNM,1",
        channel: "sync",
        topic: "sync",
        highPts: 0,
        pts: now * 1000,
        seq: 0,
        timestamp: now,
      },
    ],
  };
}

function encodeContent(kind: "text" | "image", value: Record<string, unknown>): string {
  const payload =
    kind === "text"
      ? { contentType: 1, text: { text: String(value.text ?? "") } }
      : {
          contentType: 2,
          image: {
            pics: [
              {
                type: 0,
                url: String(value.url ?? ""),
                width: Number(value.width ?? 0),
                height: Number(value.height ?? 0),
              },
            ],
          },
        };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

export function buildSendMessage(input: {
  ownerId: string;
  conversationId: string;
  receiverId: string;
  kind: "text" | "image";
  value: Record<string, unknown>;
}): Record<string, unknown> {
  const customType = input.kind === "text" ? 1 : 2;
  return {
    lwp: "/r/MessageSend/sendByReceiverScope",
    headers: { mid: generateMid() },
    body: [
      {
        uuid: `-${Date.now()}${Math.floor(Math.random() * 10)}`,
        cid: `${input.conversationId}@goofish`,
        conversationType: 1,
        content: {
          contentType: 101,
          custom: { type: customType, data: encodeContent(input.kind, input.value) },
        },
        redPointPolicy: 0,
        extension: { extJson: "{}" },
        ctx: { appVersion: "1.0", platform: "web" },
        mtags: {},
        msgReadStatusSetting: 1,
      },
      { actualReceivers: [`${input.receiverId}@goofish`, `${input.ownerId}@goofish`] },
    ],
  };
}

function walk(value: unknown): unknown[] {
  if (Array.isArray(value)) return [value, ...value.flatMap(walk)];
  if (value && typeof value === "object") return [value, ...Object.values(value).flatMap(walk)];
  return [value];
}

function decodeCustomData(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid Xianyu custom data");
  return parsed as Record<string, unknown>;
}

function decodeSyncData(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    /* Xianyu sync pushes are often base64 MessagePack. */
  }
  try {
    const encoded = Buffer.from(value, "base64");
    // Loaded lazily so cookie-only deployments can still start without decoding history.
    return decodeMsgpack(encoded);
  } catch {
    return undefined;
  }
}

export function parseInboundFrame(frame: Record<string, unknown>): XianyuInboundMessage | undefined {
  const body = frame.body as Record<string, unknown> | undefined;
  const sync = body?.syncPushPackage as Record<string, unknown> | undefined;
  const data = Array.isArray(sync?.data) ? (sync?.data[0] as Record<string, unknown> | undefined) : undefined;
  const raw = data?.data;
  const decoded = typeof raw === "string" ? decodeSyncData(raw) : raw;
  const message = walk(decoded).find((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const extension = (item as Record<string, unknown>).extension;
    return Boolean(
      extension &&
        typeof extension === "object" &&
        ((extension as Record<string, unknown>).senderUserId ||
          (extension as Record<string, unknown>).reminderContent),
    );
  }) as Record<string, unknown> | undefined;
  if (!message) return undefined;
  const extension = (message.extension as Record<string, unknown> | undefined) ?? {};
  const content = (message.content as Record<string, unknown> | undefined) ?? {};
  const custom = content.custom as Record<string, unknown> | undefined;
  let payload: Record<string, unknown> = {};
  if (typeof custom?.data === "string") {
    try {
      payload = decodeCustomData(custom.data);
    } catch {
      return undefined;
    }
  }
  const conversationId = String(message.cid ?? extension.sid ?? "").split("@", 1)[0];
  const senderId = String(extension.senderUserId ?? "");
  const externalMessageId = String(extension.messageId ?? message.messageId ?? message.uuid ?? "");
  if (!conversationId || !senderId || !externalMessageId) return undefined;
  const itemId = String(extension.itemId ?? "");
  if (payload.contentType === 1) {
    return {
      conversation: { adapter: "xianyu", tenantId: "default", conversationId, kind: "direct" },
      externalMessageId,
      senderId,
      text: String(
        (payload.text as Record<string, unknown> | undefined)?.text ?? extension.reminderContent ?? "",
      ),
      ...(itemId ? { itemId } : {}),
    };
  }
  if (payload.contentType === 2) {
    const pics =
      ((payload.image as Record<string, unknown> | undefined)?.pics as
        | Array<Record<string, unknown>>
        | undefined) ?? [];
    const url = String(pics[0]?.url ?? "");
    if (!url) return undefined;
    return {
      conversation: { adapter: "xianyu", tenantId: "default", conversationId, kind: "direct" },
      externalMessageId,
      senderId,
      text: "",
      imageUrl: url,
      ...(itemId ? { itemId } : {}),
    };
  }
  return undefined;
}
