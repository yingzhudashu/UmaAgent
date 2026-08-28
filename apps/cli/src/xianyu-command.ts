import type { UmaClient } from "@uma-agent/client";

export async function runXianyuCommand(
  client: UmaClient,
  args: string[],
  positionals: string[],
  valueAfter: (name: string) => string | undefined,
  readHidden: (prompt: string) => Promise<string>,
  print: (value: string) => void,
): Promise<void> {
  const action = positionals[0] ?? "status";
  const valid = ["status", "start", "stop", "pause", "resume", "history", "item", "chat", "publish"];
  if (!valid.includes(action))
    throw new Error(
      "uma xianyu status|start|stop|pause|resume|history <id>|item <id>|chat <receiver-id> <item-id>|publish ...",
    );
  const { grant } = await client.xianyuUnlock(await readHidden("闲鱼管理员密码: "));
  if (action === "status") return print(JSON.stringify(await client.xianyuStatus(grant), null, 2));
  if (action === "start") return void (await client.xianyuStart(grant));
  if (action === "stop") return void (await client.xianyuStop(grant));
  if (action === "pause") return void (await client.xianyuPause(grant));
  if (action === "resume") return void (await client.xianyuResume(grant));
  if (action === "history" || action === "item") {
    const id = positionals[1];
    if (!id) throw new Error(`uma xianyu ${action} <id>`);
    const result =
      action === "history" ? await client.xianyuHistory(grant, id) : await client.xianyuItem(grant, id);
    return print(JSON.stringify(result, null, 2));
  }
  if (action === "chat") {
    const receiverId = positionals[1],
      itemId = positionals[2];
    if (!receiverId || !itemId) throw new Error("uma xianyu chat <receiver-id> <item-id>");
    return print(JSON.stringify(await client.xianyuChat(grant, { receiverId, itemId }), null, 2));
  }
  const description = valueAfter("--description"),
    images = valueAfter("--image") ?? valueAfter("--images");
  if (!description || !images) throw new Error("publish requires --description and --image");
  const delivery = valueAfter("--delivery") ?? "free_shipping";
  if (!["free_shipping", "distance_based", "fixed", "pickup_only"].includes(delivery))
    throw new Error("invalid publish delivery");
  const body: Record<string, unknown> = {
    description,
    imagePaths: images
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    delivery,
  };
  for (const name of ["longitude", "latitude", "current-price", "original-price", "shipping-fee"]) {
    const value = valueAfter(`--${name}`);
    if (value) {
      const key =
        name === "current-price"
          ? "currentPrice"
          : name === "original-price"
            ? "originalPrice"
            : name === "shipping-fee"
              ? "shippingFee"
              : name;
      body[key] = value;
    }
  }
  if (!body.longitude || !body.latitude) throw new Error("publish requires --longitude and --latitude");
  if (args.includes("--self-pickup")) body.selfPickup = true;
  print(JSON.stringify(await client.xianyuPublish(grant, body), null, 2));
}
