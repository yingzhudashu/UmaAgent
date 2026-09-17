import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

const api = "/api/v16";

const token = "uma_pat_00000000-0000-4000-8000-000000000003_faux-user-3-token-012345678901234567890123";

test("shortcut search executes only a visible command and guards pending submissions", async ({ page }) => {
  const { session } = await openExistingSession(page);
  await page.getByLabel("会话更多操作", { exact: true }).click();
  await page.getByRole("button", { name: "快捷命令", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "快捷命令", exact: true });
  const search = dialog.getByPlaceholder("搜索命令");
  await expect(search).toBeFocused();
  await search.fill("session");
  await search.press("ArrowDown");
  await expect(dialog.getByRole("option", { name: /session status/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await search.press("ArrowUp");
  await expect(dialog.getByRole("option", { name: /session list/ })).toHaveAttribute("aria-selected", "true");
  await search.fill("no-such-command");
  await expect(dialog.getByRole("button", { name: "执行命令", exact: true })).toBeDisabled();
  await search.fill("后台任务");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("option")).toContainText("/btw status");
  await search.fill("重新加载配置");
  await expect(dialog.getByRole("option")).toContainText("仅管理员");
  let calls = 0;
  let release: (() => void) | undefined;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${api}/sessions/${session.id}/shortcuts`, async (route) => {
    calls++;
    expect(route.request().postDataJSON().command).toBe("/status");
    await responseGate;
    await route.fulfill({ json: { output: "隔离命令完成" } });
  });
  await search.fill("/status");
  await dialog.getByRole("button", { name: "执行 /status", exact: true }).dblclick();
  await expect.poll(() => calls).toBe(1);
  await expect(dialog.getByRole("button", { name: "执行中…" })).toBeDisabled();
  release?.();
  await expect(dialog.getByText("隔离命令完成")).toBeVisible();
  expect(calls).toBe(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("textbox", { name: "消息内容", exact: true }).focus();
  await page.keyboard.press("Control+k");
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "消息内容", exact: true })).toBeFocused();
});

test("unavailable browser storage does not turn successful online requests into failures", async ({
  page,
}) => {
  await page.addInitScript(() => {
    indexedDB.open = () => {
      throw new DOMException("Storage unavailable", "SecurityError");
    };
  });
  await openExistingSession(page);
  await expect(page.getByText("浏览器无法保存离线缓存，当前页面可继续使用。")).toBeVisible();
  await page.getByRole("textbox", { name: "消息内容", exact: true }).fill("缓存不可用时继续在线对话");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("Faux Core received: 缓存不可用时继续在线对话", { exact: true })).toBeVisible();
});

test("events completed before the first HTTP snapshot arrives are replayed into the conversation", async ({
  page,
}) => {
  const headers = { authorization: `Bearer ${token}` };
  const created = await page.request.post(`${api}/sessions`, {
    headers,
    data: { title: `迟到快照 ${randomUUID()}` },
  });
  expect(created.ok()).toBeTruthy();
  const session = await created.json();
  let injected = false;
  await page.route(`**${api}/sessions/${session.id}/snapshot`, async (route) => {
    const stale = await route.fetch();
    if (!injected) {
      injected = true;
      const accepted = await page.request.post(`${api}/sessions/${session.id}/messages`, {
        headers,
        data: { messageId: randomUUID(), text: "快照回执前已经完成", mode: "agent" },
      });
      expect(accepted.ok()).toBeTruthy();
      const { runId } = await accepted.json();
      await expect
        .poll(async () => {
          const result = await page.request.get(`${api}/runs/${runId}`, { headers });
          return (await result.json()).status;
        })
        .toBe("completed");
    }
    await route.fulfill({ response: stale });
  });
  await page.goto("/");
  await page.getByLabel("访问令牌").fill(token);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByText("Faux Core received: 快照回执前已经完成", { exact: true })).toBeVisible();
  expect(injected).toBe(true);
});

test("lost acceptance reply reconciles history without a second execution", async ({ page }) => {
  const { session } = await openExistingSession(page);
  const input = page.getByRole("textbox", { name: "消息内容", exact: true });
  let posts = 0;
  await page.route(`**${api}/sessions/${session.id}/messages`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    await route.abort("failed");
  });
  await input.fill("回执丢失只能执行一次");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".composer-error")).toBeVisible();
  await expect(input).toHaveValue("回执丢失只能执行一次");
  await expect(input).toHaveAttribute("readonly", "");
  await page.getByRole("button", { name: "核对并重试发送", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(input).not.toHaveAttribute("readonly", "");
  expect(posts).toBe(1);
});

test("drafts stay in their conversation when navigating to another session", async ({ page }) => {
  const { session } = await openExistingSession(page);
  const input = page.getByRole("textbox", { name: "消息内容", exact: true });
  await input.fill("原会话独立草稿");
  await page.getByRole("button", { name: "新会话", exact: true }).click();
  await expect(page.locator(".workspace h1")).not.toHaveText(session.title);
  await expect(input).toHaveValue("");
  await input.fill("新会话独立草稿");
  await page.locator(".session-list button").filter({ hasText: session.title }).click();
  await expect(input).toHaveValue("原会话独立草稿");
});

async function openExistingSession(page: Page) {
  const headers = { authorization: `Bearer ${token}` };
  const response = await page.request.post(`${api}/sessions`, {
    headers,
    data: { title: `原有会话 ${randomUUID()}` },
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  const message = await page.request.post(`${api}/sessions/${session.id}/messages`, {
    headers,
    data: { messageId: randomUUID(), text: "原有会话的消息", mode: "agent" },
  });
  expect(message.ok()).toBeTruthy();
  await page.context().clearCookies();
  await page.goto("/");
  const login = page.getByLabel("访问令牌");
  await login.fill(token);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
  if ((page.viewportSize()?.width ?? 1440) < 600)
    await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".session-list button").filter({ hasText: session.title }).click();
  await expect(page.locator(".workspace h1")).toHaveText(session.title);
  await expect(page.getByRole("region", { name: "会话消息" })).toContainText("原有会话的消息");
  const bootstrap = await page.request.post(`${api}/sync/bootstrap`, { headers });
  expect(bootstrap.ok()).toBeTruthy();
  return { session, bootstrap: await bootstrap.json() };
}

test("composer supports keyboard upload, text limits and IME composition", async ({ page }) => {
  await openExistingSession(page);
  const upload = page.getByRole("button", { name: "上传文件", exact: true });
  const input = page.getByRole("textbox", { name: "消息内容", exact: true });
  await input.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(upload).toBeFocused();
  const choosing = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await choosing).setFiles([]);
  await input.fill("字".repeat(20_001));
  await expect(input).toHaveValue("字".repeat(20_000));
  await input.fill("中文输入");
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/messages")) writes += 1;
  });
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(input).toHaveValue("中文输入");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("中文输入\n");
  expect(writes).toBe(0);
  const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/messages"));
  await input.press("Enter");
  expect((await sent).postDataJSON().text).toBe("中文输入");
  await expect(input).toHaveValue("");
  expect(writes).toBe(1);
});

for (const mobile of [false, true]) {
  for (const unavailable of [false, true]) {
    test(`new session opens with ${unavailable ? "unavailable" : "stale"} lists (${mobile ? "mobile" : "desktop"})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: mobile ? 390 : 1440, height: 900 });
      const { session: old, bootstrap } = await openExistingSession(page);
      let staleReads = 0;
      await page.route(`**${api}/sync/bootstrap`, async (route) => {
        staleReads += 1;
        await route.fulfill(
          unavailable ? { status: 503, json: { error: "列表暂时不可用" } } : { json: bootstrap },
        );
      });
      await page.route(`**${api}/sessions`, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const response = await route.fetch({ postData: JSON.stringify({ title: "新建目标会话" }) });
        await route.fulfill({ response });
      });
      if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
      const created = page.waitForResponse(
        (r) => r.url().endsWith(`${api}/sessions`) && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "新会话", exact: true }).click();
      const target = await (await created).json();
      expect(target.id).not.toBe(old.id);
      await expect(page.locator(".workspace h1")).toHaveText("新建目标会话");
      await expect(page.getByRole("region", { name: "会话消息" })).not.toContainText("原有会话的消息");
      if (mobile) await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
      const input = page.getByPlaceholder("向 UmaAgent 发送消息");
      await input.fill("仅发送到新会话");
      const readsBeforeSend = staleReads;
      const sent = page.waitForRequest((r) => r.url().endsWith("/messages") && r.method() === "POST");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      expect((await sent).url()).toContain(`/sessions/${target.id}/messages`);
      await expect(page.getByRole("region", { name: "会话消息" })).toContainText("仅发送到新会话");
      await expect.poll(() => staleReads).toBeGreaterThan(readsBeforeSend);
      await expect(page.locator(".workspace h1")).toHaveText("新建目标会话");
      await expect(page.locator(".session-list button.active")).toContainText("新建目标会话");
    });
  }
}

test("new session returns from settings to chat", async ({ page }) => {
  await openExistingSession(page);
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await expect(page.locator(".workspace")).toBeHidden();
  const created = page.waitForResponse(
    (r) => r.url().endsWith(`${api}/sessions`) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "新会话", exact: true }).click();
  const target = await (await created).json();
  await expect(page.locator(".workspace")).toBeVisible();
  await expect(page.locator(".workspace h1")).toHaveText(target.title);
  await expect(page.locator(".session-list button.active")).toContainText(target.title);
});

test("failed creation keeps the current conversation and draft", async ({ page }) => {
  const { session } = await openExistingSession(page);
  const input = page.getByPlaceholder("向 UmaAgent 发送消息");
  await input.fill("保留原会话草稿");
  let posts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${api}/sessions`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    await gate;
    await route.fulfill({ status: 503, json: { error: "会话创建暂时不可用" } });
  });
  await page.getByRole("button", { name: "新会话", exact: true }).click();
  await expect(page.getByRole("button", { name: "创建中…", exact: true })).toBeDisabled();
  release();
  await expect(page.locator(".sidebar-error")).toBeVisible();
  await expect(page.locator(".workspace h1")).toHaveText(session.title);
  await expect(input).toHaveValue("保留原会话草稿");
  expect(posts).toBe(1);
});

test("pending creation and double submit cannot send to the previous session", async ({ page }) => {
  const { session: old } = await openExistingSession(page);
  const input = page.getByPlaceholder("向 UmaAgent 发送消息");
  await input.fill("创建完成后发送的草稿");
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  await page.route(`**${api}/sessions`, async (route) => {
    if (route.request().method() === "POST") await createGate;
    await route.continue();
  });
  const created = page.waitForResponse(
    (r) => r.url().endsWith(`${api}/sessions`) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "新会话", exact: true }).click();
  await expect(input).toBeDisabled();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  releaseCreate();
  const target = await (await created).json();
  expect(target.id).not.toBe(old.id);
  await expect(input).toBeEnabled();
  // 新会话拥有独立草稿，不能把旧会话未发送的内容悄悄搬过来。
  await expect(input).toHaveValue("");
  await input.fill("创建完成后发送的草稿");
  let writes = 0;
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  await page.route(`**${api}/sessions/*/messages`, async (route) => {
    if (route.request().method() === "POST") {
      writes++;
      expect(route.request().url()).toContain(`/sessions/${target.id}/messages`);
      await sendGate;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  await expect(input).toBeDisabled();
  await page.locator("form.composer").evaluate((form: HTMLFormElement) => form.requestSubmit());
  releaseSend();
  await expect(page.getByRole("region", { name: "会话消息" })).toContainText("创建完成后发送的草稿");
  expect(writes).toBe(1);
});
