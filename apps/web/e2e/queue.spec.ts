import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { SessionSnapshot } from "@uma-agent/protocol";

test("queue actions remain reachable at 320px and protect edits and in-flight writes", async ({ page }) => {
  const registered = await page.request.post("/api/v16/auth/register", { data: { label: "queue-e2e" } });
  expect(registered.ok()).toBeTruthy();
  const { token } = await registered.json();
  const headers = { authorization: `Bearer ${token}` };
  const created = await page.request.post("/api/v16/sessions", {
    headers,
    data: { title: `队列验收 ${randomUUID()}` },
  });
  expect(created.ok()).toBeTruthy();
  const session = await created.json();
  const accepted = await page.request.post(`/api/v16/sessions/${session.id}/messages`, {
    headers,
    data: { messageId: randomUUID(), text: "队列样本", mode: "agent" },
  });
  const { runId } = await accepted.json();
  await expect
    .poll(async () => (await (await page.request.get(`/api/v16/runs/${runId}`, { headers })).json()).status)
    .toBe("completed");
  const snapshot: SessionSnapshot = await (
    await page.request.get(`/api/v16/sessions/${session.id}/snapshot`, { headers })
  ).json();
  const run = snapshot.recentRuns.find((item) => item.id === runId);
  const message = snapshot.transcript.find((item) => item.id === run?.messageId);
  if (!run || !message) throw new Error("Missing real queue seed");
  // 用真实协议记录建立稳定的等待队列，只隔离队列调度，不引入产品延迟开关。
  let queue: SessionSnapshot["queue"] = [1, 2].map((position) => {
    const messageId = randomUUID();
    return {
      position,
      run: { ...run, id: randomUUID(), messageId, status: "queued" },
      message: { ...message, id: messageId, content: `等待消息 ${position}` },
    };
  });
  await page.route(`**/api/v16/sessions/${session.id}/queue`, (route) => route.fulfill({ json: queue }));
  await page.route(`**/api/v16/sessions/${session.id}/snapshot`, (route) =>
    route.fulfill({ json: { ...snapshot, queue } }),
  );
  await page.route(`**/api/v16/sessions/${session.id}/queue/reorder`, async (route) => {
    const { runIds } = route.request().postDataJSON();
    queue = runIds.map((id: string, index: number) => ({
      ...queue.find((item) => item.run.id === id),
      position: index + 1,
    }));
    await route.fulfill({ json: queue });
  });
  let releaseWrite: (() => void) | undefined;
  let edits = 0;
  await page.route("**/api/v16/messages/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    edits++;
    await new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const item = queue.find((value) => value.message.id === id);
    if (!item) throw new Error("Missing edited queue item");
    item.message.content = route.request().postDataJSON().text;
    await route.fulfill({ json: { runId: item.run.id, messageId: id, status: "queued" } });
  });
  await page.route("**/api/v16/runs/*/cancel", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    const removed = queue.find((item) => item.run.id === id);
    queue = queue
      .filter((item) => item.run.id !== id)
      .map((item, index) => ({ ...item, position: index + 1 }));
    await route.fulfill({ json: { ...removed?.run, status: "cancelled" } });
  });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: session.title })).toBeVisible();
  const dock = page.getByRole("region", { name: "消息队列" });
  await dock.getByRole("button", { name: /查看队列/ }).click();
  const more = dock.getByLabel("队列第 1 条更多操作");
  await more.focus();
  await page.keyboard.press("ArrowDown");
  const menu = more.locator("..");
  const available = menu.locator("button:not(:disabled)");
  await expect(available.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(available.last()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(available.first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await expect(menu).not.toHaveAttribute("open", "");
  await more.click();
  await dock.getByRole("button", { name: "编辑消息", exact: true }).click();
  const editor = dock.getByLabel("队列消息内容");
  await editor.fill("保留编辑内容");
  await dock.getByRole("button", { name: "取消编辑", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "放弃未保存内容？" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(editor).toHaveValue("保留编辑内容");
  await dock.getByRole("button", { name: "保存编辑", exact: true }).click();
  await expect(editor).toBeDisabled();
  await expect.poll(() => edits).toBe(1);
  releaseWrite?.();
  await expect(editor).toHaveCount(0);
  await expect(dock).toContainText("保留编辑内容");
  await dock.getByLabel("队列第 1 条更多操作").click();
  await dock.getByRole("button", { name: "下移", exact: true }).click();
  await expect(dock.locator(".queue-dock__item").first()).toContainText("等待消息 2");
  await dock.getByLabel("队列第 2 条更多操作").click();
  const cancel = dock.getByRole("button", { name: "取消消息", exact: true });
  await cancel.scrollIntoViewIfNeeded();
  await expect(cancel).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/acceptance/web-queue-320.png" });
  await cancel.click();
  await expect(dock.locator(".queue-dock__item")).toHaveCount(1);
  await expect(dock).not.toContainText("保留编辑内容");
});
