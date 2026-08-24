import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  APP_KEY,
  formatCookieHeader,
  generateDeviceId,
  IM_APP_KEY,
  mtopSign,
  parseCookieHeader,
} from "./protocol.js";

const BASE = "https://h5api.m.goofish.com/h5";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36";

export class XianyuAuthError extends Error {}
export class XianyuProtocolError extends Error {}

function responseData(payload: Record<string, unknown>): Record<string, unknown> {
  const value = payload.data;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cents(value: string | number): string {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("金额必须是非负数字");
  return String(Math.round(amount * 100));
}

export class XianyuClient {
  readonly ownerId: string;
  readonly deviceId: string;
  private cookies: Record<string, string>;
  constructor(
    cookieHeader: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.cookies = parseCookieHeader(cookieHeader);
    this.ownerId = this.cookies.unb?.trim() ?? "";
    if (!this.ownerId) throw new XianyuAuthError("XIANYU_COOKIE 缺少 unb");
    if (!this.cookies._m_h5_tk) throw new XianyuAuthError("XIANYU_COOKIE 缺少 _m_h5_tk");
    this.deviceId = generateDeviceId(this.ownerId);
  }
  cookieHeader(): string {
    return formatCookieHeader(this.cookies);
  }
  private token(): string {
    const token = this.cookies._m_h5_tk?.split("_", 1)[0] ?? "";
    if (!token) throw new XianyuAuthError("XIANYU_COOKIE 的 _m_h5_tk 无效");
    return token;
  }
  private async mtop(
    api: string,
    version: string,
    data: Record<string, unknown>,
    retry = true,
  ): Promise<Record<string, unknown>> {
    const serialized = JSON.stringify(data);
    const timestamp = String(Date.now());
    const params = new URLSearchParams({
      jsv: "2.7.2",
      appKey: APP_KEY,
      t: timestamp,
      sign: mtopSign(timestamp, this.token(), serialized),
      v: version,
      type: "originaljson",
      accountSite: "xianyu",
      dataType: "json",
      timeout: "20000",
      api,
      sessionOption: "AutoLoginOnly",
    });
    const response = await this.fetchFn(`${BASE}/${api}/${version}/?${params}`, {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
        origin: "https://www.goofish.com",
        referer: "https://www.goofish.com/",
        "content-type": "application/x-www-form-urlencoded",
        cookie: this.cookieHeader(),
      },
      body: new URLSearchParams({ data: serialized }),
    });
    if (!response.ok) throw new XianyuProtocolError(`闲鱼 HTTP ${response.status}`);
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new XianyuProtocolError(`${api} 返回格式错误`);
    const value = payload as Record<string, unknown>;
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      for (const part of setCookie.split(/,(?=[^;=]+=[^;]+)/)) {
        const pair = part.split(";", 1)[0] ?? "";
        const [name, ...rest] = pair.trim().split("=");
        if (name && rest.length) this.cookies[name] = rest.join("=");
      }
    }
    const ret = Array.isArray(value.ret) ? value.ret.map(String).join(" ") : "";
    if (retry && (ret.includes("令牌过期") || ret.includes("TOKEN_EXPIRED"))) {
      await this.mtop("mtop.taobao.idlemessage.pc.loginuser.get", "1.0", {}, false);
      return this.mtop(api, version, data, false);
    }
    if (/FAIL_SYS_SESSION_EXPIRED|令牌过期|非法请求|NEED_LOGIN/.test(ret))
      throw new XianyuAuthError(`闲鱼认证失败: ${ret}`);
    return value;
  }
  async getAccessToken(): Promise<string> {
    const payload = await this.mtop("mtop.taobao.idlemessage.pc.login.token", "1.0", {
      appKey: IM_APP_KEY,
      deviceId: this.deviceId,
    });
    const token = String(responseData(payload).accessToken ?? "");
    if (!token) throw new XianyuAuthError("闲鱼未返回 IM accessToken");
    return token;
  }
  refreshLogin(): Promise<Record<string, unknown>> {
    return this.mtop("mtop.taobao.idlemessage.pc.loginuser.get", "1.0", {});
  }
  getItem(itemId: string): Promise<Record<string, unknown>> {
    return this.mtop("mtop.taobao.idle.pc.detail", "1.0", { itemId });
  }
  async uploadImage(path: string): Promise<{ url: string; width: number; height: number }> {
    const bytes = await readFile(path);
    const type = path.toLowerCase().endsWith(".png")
      ? "image/png"
      : path.toLowerCase().endsWith(".webp")
        ? "image/webp"
        : "image/jpeg";
    const form = new FormData();
    form.append("file", new Blob([bytes], { type }), basename(path));
    const response = await this.fetchFn(
      "https://stream-upload.goofish.com/api/upload.api?floderId=0&appkey=xy_chat&_input_charset=utf-8",
      {
        method: "POST",
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json",
          origin: "https://www.goofish.com",
          referer: "https://www.goofish.com/",
          cookie: this.cookieHeader(),
        },
        body: form,
      },
    );
    if (!response.ok) throw new XianyuProtocolError(`闲鱼图片上传 HTTP ${response.status}`);
    const payload = (await response.json()) as Record<string, unknown>;
    const image = payload.object as Record<string, unknown> | undefined;
    const url = String(image?.url ?? "");
    if (!url) throw new XianyuProtocolError("闲鱼图片上传未返回 URL");
    const [width = 0, height = 0] = String(image?.pix ?? "0x0")
      .split("x")
      .map((part) => Number(part) || 0);
    return { url, width, height };
  }

  async recommendPublishCategory(
    description: string,
    images: Array<{ url: string; width: number; height: number }>,
  ): Promise<Record<string, unknown>> {
    if (!description.trim() || !images.length) throw new Error("发布商品需要描述和至少一张图片");
    const imageInfos = images.map((image, index) => ({
      extraInfo: { isH: "false", isT: "false", raw: "false" },
      isQrCode: false,
      url: image.url,
      heightSize: image.height,
      widthSize: image.width,
      major: index === 0,
      type: 0,
      status: "done",
    }));
    return this.mtop("mtop.taobao.idle.kgraph.property.recommend", "2.0", {
      title: description,
      lockCpv: false,
      multiSKU: false,
      publishScene: "mainPublish",
      scene: "newPublishChoice",
      description,
      imageInfos,
      uniqueCode: String(Date.now()),
    });
  }

  async getLocation(longitude: string | number, latitude: string | number): Promise<Record<string, unknown>> {
    const payload = await this.mtop("mtop.taobao.idle.local.poi.get", "1.0", {
      longitude: String(longitude),
      latitude: String(latitude),
    });
    const addresses = (responseData(payload).commonAddresses as unknown[]) ?? [];
    const first = addresses[0];
    if (!first || typeof first !== "object") throw new XianyuProtocolError("闲鱼未返回发布地址");
    return first as Record<string, unknown>;
  }

  async publishItem(input: {
    imagePaths: string[];
    description: string;
    delivery: "free_shipping" | "distance_based" | "fixed" | "pickup_only";
    longitude: string | number;
    latitude: string | number;
    currentPrice?: string | number;
    originalPrice?: string | number;
    shippingFee?: string | number;
    selfPickup?: boolean;
  }): Promise<Record<string, unknown>> {
    if (!input.description.trim()) throw new Error("商品描述不能为空");
    if (!input.imagePaths.length) throw new Error("至少需要一张商品图片");
    if (input.delivery === "fixed" && input.shippingFee === undefined)
      throw new Error("固定运费模式需要 shippingFee");
    const images = await Promise.all(input.imagePaths.map((path) => this.uploadImage(path)));
    const recommendation = await this.recommendPublishCategory(input.description, images);
    const data = responseData(recommendation);
    const prediction = (data.categoryPredictResult as Record<string, unknown> | undefined) ?? {};
    if (!prediction.catId) throw new XianyuProtocolError("闲鱼分类推荐未返回 catId");
    const location = await this.getLocation(input.longitude, input.latitude);
    const selectedLabels = ((data.cardList as unknown[]) ?? []).flatMap((card) => {
      const cardData = (card as Record<string, unknown>)?.cardData as Record<string, unknown> | undefined;
      const values = (cardData?.valuesList as unknown[]) ?? [];
      const selected = values.find((value) => (value as Record<string, unknown>)?.isClicked) as
        | Record<string, unknown>
        | undefined;
      if (!selected) return [];
      return [
        {
          channelCateName: selected.catName,
          channelCateId: selected.channelCatId,
          tbCatId: selected.tbCatId,
          propertyName: cardData?.propertyName,
          propertyId: cardData?.propertyId,
          isUserClick: "1",
          from: "newPublishChoice",
          labelFrom: "newPublish",
          text: selected.catName,
          properties: `${cardData?.propertyId}##${cardData?.propertyName}:${selected.channelCatId}##${selected.catName}`,
        },
      ];
    });
    const deliveryFee = {
      canFreeShipping: input.delivery === "free_shipping",
      supportFreight: input.delivery !== "pickup_only",
      onlyTakeSelf: input.delivery === "pickup_only",
      ...(input.delivery === "distance_based" ? { templateId: "-100" } : {}),
      ...(input.delivery === "fixed"
        ? { templateId: "0", postPriceInCent: cents(input.shippingFee as string | number) }
        : {}),
      ...(input.delivery === "pickup_only" ? { templateId: "0" } : {}),
    };
    return this.mtop("mtop.idle.pc.idleitem.publish", "1.0", {
      freebies: false,
      itemTypeStr: "b",
      quantity: "1",
      simpleItem: "true",
      imageInfoDOList: images.map((image, index) => ({
        extraInfo: { isH: "false", isT: "false", raw: "false" },
        isQrCode: false,
        url: image.url,
        heightSize: image.height,
        widthSize: image.width,
        major: index === 0,
        type: 0,
        status: "done",
      })),
      itemTextDTO: { desc: input.description, title: input.description, titleDescSeparate: false },
      itemLabelExtList: selectedLabels,
      itemPriceDTO: {
        ...(input.currentPrice === undefined ? {} : { priceInCent: cents(input.currentPrice) }),
        ...(input.originalPrice === undefined ? {} : { origPriceInCent: cents(input.originalPrice) }),
      },
      userRightsProtocols: [{ enable: false, serviceCode: "SKILL_PLAY_NO_MIND" }],
      itemPostFeeDTO: deliveryFee,
      itemAddrDTO: {
        area: location.area,
        city: location.city,
        divisionId: location.divisionId,
        gps: `${location.longitude},${location.latitude}`,
        poiId: location.poiId,
        poiName: location.poi,
        prov: location.prov,
      },
      defaultPrice: input.currentPrice === undefined && input.originalPrice === undefined,
      itemCatDTO: {
        catId: String(prediction.catId),
        catName: String(prediction.catName ?? ""),
        channelCatId: String(prediction.channelCatId ?? ""),
        tbCatId: String(prediction.tbCatId ?? ""),
      },
      uniqueCode: String(Date.now()),
      sourceId: "pcMainPublish",
      bizcode: "pcMainPublish",
      publishScene: "pcMainPublish",
      onlyTakeSelf: Boolean(input.selfPickup || input.delivery === "pickup_only"),
    });
  }
}
