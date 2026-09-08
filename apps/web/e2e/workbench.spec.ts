import { expect, type Page, test } from "@playwright/test";

let sharedToken: string | undefined;

test("switches from Xianyu admin to a normal account without stopping the adapter", async ({ page }) => {
  const registered = await page.request.post("/api/v15/auth/register", { data: { label: "switch-user" } });
  expect(registered.ok()).toBeTruthy();
  const ordinary = (await registered.json()) as { token: string };
  await page.context().clearCookies();
  const channelRequests: string[] = [];
  await page.route("**/api/v15/xianyu/**", async (route) => {
    channelRequests.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      json: {
        workspace: "xianyu",
        autoReplyEnabled: true,
        service: { connected: true },
        login: { status: "authenticated" },
        sessions: [],
      },
    });
  });
  let socketsClosed = 0;
  page.on("websocket", (socket) =>
    socket.on("close", () => {
      socketsClosed += 1;
    }),
  );
  await page.goto("/");
  await page
    .getByLabel("访问令牌")
    .fill("uma_pat_00000000-0000-4000-8000-000000000001_faux-local-token-012345678901234567890123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "切换普通账号" })).toBeVisible();
  await expect.poll(() => channelRequests.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "切换普通账号" }).click();
  await expect(page.getByLabel("访问令牌")).toBeVisible();
  await expect.poll(() => socketsClosed).toBeGreaterThan(0);
  const requestsAtSwitch = channelRequests.length;
  await page.getByLabel("访问令牌").fill(ordinary.token);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByText("Core 已连接")).toBeVisible();
  await expect(page.getByRole("button", { name: "切换普通账号" })).toHaveCount(0);
  // 覆盖一次工作台刷新周期，确认卸载后的轮询没有带着普通账号继续访问管理接口。
  await page.waitForTimeout(10_100);
  expect(channelRequests.length).toBe(requestsAtSwitch);
  expect(channelRequests.some((path) => /\/(stop|pause|logout)$/.test(path))).toBe(false);
  const forbidden = await page.request.get("/api/v15/xianyu/status", {
    headers: { authorization: `Bearer ${ordinary.token}` },
  });
  expect(forbidden.status()).toBe(403);
});

async function register(page: Page, reuse = false): Promise<string> {
  if (reuse && sharedToken) {
    await login(page, sharedToken);
    return sharedToken;
  }
  await page.goto("/");
  await page.getByRole("button", { name: "创建新账户" }).click();
  await page.getByLabel("令牌名称").fill("e2e");
  await page.getByRole("button", { name: "注册", exact: true }).click();
  const text = await page.locator(".token-result").textContent();
  const token = text?.match(/uma_pat_[A-Za-z0-9_-]+/)?.[0];
  if (!token) throw new Error("Registration did not return a personal token");
  sharedToken = token;
  await page.getByRole("button", { name: "继续进入" }).click();
  await expect(page.getByText("Core 已连接")).toBeVisible();
  return token;
}

async function login(page: Page, token: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("访问令牌").fill(token);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("Core 已连接")).toBeVisible();
}

test("registration presents a one-time token before entering the workbench", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "创建新账户" }).click();
  await page.getByLabel("令牌名称").fill("e2e-registration");
  await page.getByRole("button", { name: "注册", exact: true }).click();

  const result = page.locator(".token-result");
  await expect(result).toContainText("请立即保存此令牌");
  const token = (await result.textContent())?.match(/uma_pat_[A-Za-z0-9_-]+/)?.[0];
  if (!token) throw new Error("Registration did not return a personal token");
  sharedToken = token;

  await expect(page.getByLabel("令牌名称")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "注册", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "复制令牌" }).click();
  await expect(page.getByRole("button", { name: "已复制" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
  await page.getByRole("button", { name: "继续进入" }).click();
  await expect(page.getByText("Core 已连接")).toBeVisible();
});

test("two devices converge on one session and offline mode is read-only", async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  const token = await register(first);
  await first.getByRole("button", { name: "新会话" }).click();
  await expect(first.getByPlaceholder("向 UmaAgent 发送消息")).toBeEnabled();
  await expect(first.locator(".status-rail button")).toHaveCount(5);
  await first.getByRole("button", { name: "会话设置" }).click();
  await expect(first.getByRole("dialog", { name: "会话设置" })).toBeVisible();
  await first.keyboard.press("Escape");
  await expect(first.getByRole("dialog", { name: "会话设置" })).toHaveCount(0);
  await expect(first.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true");
  await first.getByRole("button", { name: "Agent" }).click();
  await expect(first.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true");
  await first.getByRole("button", { name: "快捷命令" }).click();
  await expect(first.getByRole("dialog", { name: "快捷命令" })).toBeVisible();
  await first.getByRole("button", { name: /执行 \/help/ }).click();
  await expect(first.getByRole("dialog", { name: "快捷命令" }).getByText(/可用命令/)).toBeVisible();
  await first.getByRole("button", { name: "关闭快捷命令" }).click();

  await login(second, token);
  await expect(second.getByRole("button", { name: /New session/ }).first()).toBeVisible();
  await second
    .getByRole("button", { name: /New session/ })
    .first()
    .click();

  await first.getByPlaceholder("向 UmaAgent 发送消息").fill("multi device hello");
  await first.getByRole("button", { name: "发送" }).click();
  await expect(first.getByText("Faux Core received: multi device hello")).toBeVisible();
  await expect(second.getByText("Faux Core received: multi device hello")).toBeVisible();
  const desktopAvatar = await first
    .locator(".message-avatar")
    .first()
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
  expect(desktopAvatar).toEqual({ width: 64, height: 64 });

  await secondContext.setOffline(true);
  await expect(second.getByPlaceholder("向 UmaAgent 发送消息")).toBeDisabled();
  await expect(second.getByText("Faux Core received: multi device hello")).toBeVisible();

  await first.setViewportSize({ width: 390, height: 844 });
  const mobileAvatar = await first
    .locator(".message-avatar")
    .first()
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
  expect(mobileAvatar).toEqual({ width: 56, height: 56 });
  await first.getByRole("button", { name: "会话设置" }).click();
  const settings = first.getByRole("dialog", { name: "会话设置" });
  for (const [area, heading] of [
    ["任务", "后台任务"],
    ["记忆", "记忆"],
    ["调度", "调度"],
    ["资源", "知识库"],
  ]) {
    await settings
      .getByRole("navigation", { name: "设置区域" })
      .getByRole("button", { name: area, exact: true })
      .click();
    await expect(settings.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(settings.locator(".settings-section--operation")).toHaveCount(1);
    const widths = await settings
      .locator(".settings-section--operation")
      .evaluateAll((sections) =>
        sections.map((section) => ({ scrollWidth: section.scrollWidth, clientWidth: section.clientWidth })),
      );
    expect(widths.every(({ scrollWidth, clientWidth }) => scrollWidth <= clientWidth)).toBe(true);
  }
  await settings.getByRole("button", { name: "会话与账号", exact: true }).click();
  first.once("dialog", (dialog) => dialog.accept());
  await settings.getByRole("button", { name: "退出登录" }).click();
  await expect(first.getByLabel("访问令牌")).toBeVisible();
  await expect(first.getByPlaceholder("向 UmaAgent 发送消息")).toHaveCount(0);

  await firstContext.close();
  await secondContext.close();
});

test("pastes an image into the composer and sends it as an attachment", async ({ page }) => {
  await register(page, true);
  await page.getByRole("button", { name: "新会话" }).click();
  const input = page.getByPlaceholder("向 UmaAgent 发送消息");
  await input.evaluate((element) => {
    const file = new File([new Uint8Array([137, 80, 78, 71])], "clipboard.png", { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
  });
  await expect(page.getByRole("button", { name: /pasted-image-.*\.png ×/ })).toBeVisible();
  await page.getByRole("button", { name: "发送" }).click();
  await expect(
    page.getByText(/模型服务暂时不可用|Configured vision model does not support image input/),
  ).toBeVisible();
});

test("keeps the workbench fixed while the transcript and settings scroll independently", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page, true);
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name: "新会话" }).click();
  const input = page.getByPlaceholder("向 UmaAgent 发送消息");
  const transcript = page.locator(".transcript");

  for (let index = 0; index < 16; index += 1) {
    const prompt = `scroll check ${index} ${"long message content ".repeat(8)}`;
    await input.fill(prompt);
    await page.getByRole("button", { name: "发送" }).click();
    await expect(
      page.getByText(`Faux Core received: ${prompt.slice(0, 300)}`, { exact: true }),
    ).toBeVisible();
  }

  const layout = await page.locator(".uma-embed").evaluate((root) => {
    const shell = root.querySelector<HTMLElement>(".app-shell");
    const workspace = root.querySelector<HTMLElement>(".workspace");
    const messages = root.querySelector<HTMLElement>(".transcript");
    const header = root.querySelector<HTMLElement>(".workspace > header");
    const composer = root.querySelector<HTMLElement>(".composer-wrap");
    if (!shell || !workspace || !messages || !header || !composer)
      throw new Error("workbench layout missing");
    return {
      root: { width: root.scrollWidth, height: root.scrollHeight, clientHeight: root.clientHeight },
      shell: { width: shell.scrollWidth, height: shell.scrollHeight, clientHeight: shell.clientHeight },
      workspace: {
        width: workspace.scrollWidth,
        height: workspace.scrollHeight,
        clientHeight: workspace.clientHeight,
      },
      transcript: {
        scrollHeight: messages.scrollHeight,
        clientHeight: messages.clientHeight,
        scrollTop: messages.scrollTop,
      },
      headerTop: header.getBoundingClientRect().top,
      composerBottom: composer.getBoundingClientRect().bottom,
    };
  });
  expect(layout.root.width).toBeLessThanOrEqual(390);
  expect(layout.root.height).toBeLessThanOrEqual(844);
  expect(layout.shell.width).toBeLessThanOrEqual(390);
  expect(layout.workspace.width).toBeLessThanOrEqual(390);
  expect(layout.transcript.scrollHeight).toBeGreaterThan(layout.transcript.clientHeight);

  await transcript.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForTimeout(100);
  const topBeforeNewMessage = await transcript.evaluate((element) => element.scrollTop);
  expect(topBeforeNewMessage).toBe(0);

  const followup = "message while reading history";
  await input.fill(followup);
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText(`Faux Core received: ${followup}`, { exact: true })).toBeVisible();
  const topAfterNewMessage = await transcript.evaluate((element) => element.scrollTop);
  expect(topAfterNewMessage).toBeLessThan(120);

  await page.getByRole("button", { name: "最新消息" }).click();
  await expect
    .poll(
      async () => {
        const tail = await transcript.evaluate((element) => ({
          top: element.scrollTop,
          height: element.scrollHeight,
          client: element.clientHeight,
        }));
        return tail.height - tail.top - tail.client;
      },
      { timeout: 3000 },
    )
    .toBeLessThanOrEqual(2);

  await page.getByRole("button", { name: "会话设置" }).click();
  const settings = page.getByRole("dialog", { name: "会话设置" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("heading", { name: "当前会话" })).toBeVisible();
  await expect(settings.getByText("Agent Profile")).toBeVisible();
  await expect(settings.getByText("应用与诊断")).toBeVisible();
  await expect(settings.getByText("账号操作")).toBeVisible();

  const fontStyles = await settings.getByRole("button", { name: "保存 Profile" }).evaluate((button) => {
    const style = getComputedStyle(button);
    return {
      family: style.fontFamily,
      size: style.fontSize,
      weight: style.fontWeight,
      lineHeight: style.lineHeight,
    };
  });
  const secondaryStyles = await settings.getByRole("button", { name: "重新加载配置" }).evaluate((button) => {
    const style = getComputedStyle(button);
    return {
      family: style.fontFamily,
      size: style.fontSize,
      weight: style.fontWeight,
      lineHeight: style.lineHeight,
    };
  });
  expect(fontStyles).toEqual(secondaryStyles);
  await settings.getByLabel("Profile 内容").fill("保持简洁并先说明风险。");
  await settings.getByRole("button", { name: "保存 Profile" }).click();
  await expect(settings.getByText("Profile 已同步到当前账号。")).toBeVisible();
});

test("keeps tool output collapsed until requested", async ({ page }) => {
  await register(page, true);
  await page.getByRole("button", { name: "新会话" }).click();
  await page.getByRole("button", { name: "Agent" }).click();
  const input = page.getByPlaceholder("向 UmaAgent 发送消息");
  await input.fill("Use the configured deterministic read tool and report its result.");
  await page.getByRole("button", { name: "发送" }).click();
  const steps = page.locator(".response-steps").first();
  // 工具调用需要经过一次模型响应和一次工具事件；低资源 CI 上可能
  // 超过 Playwright 默认 5 秒，但仍属于同一次请求的正常完成范围。
  await expect(steps).toBeVisible({ timeout: 15_000 });
  await expect(steps).not.toHaveAttribute("open", "", { timeout: 15_000 });
  await steps.locator(":scope > summary").click();
  await expect(steps).toHaveAttribute("open", "", { timeout: 15_000 });
  const tool = page.locator(".tool-details").first();
  await expect(tool).toBeVisible({ timeout: 15_000 });
  await expect(tool).not.toHaveAttribute("open", "", { timeout: 15_000 });
  await tool.locator("summary").click();
  await expect(tool).toHaveAttribute("open", "", { timeout: 15_000 });
  const toolOutput = tool.locator("pre");
  await toolOutput.evaluate((element) => {
    element.textContent = `web_search result https://example.com/${"unbroken-result-".repeat(90)}`;
  });
  await expect
    .poll(() => toolOutput.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
  const markdownCodeOverflow = await page.evaluate(() => {
    const container = document.createElement("div");
    container.className = "markdown";
    const code = document.createElement("pre");
    container.append(code);
    document.querySelector(".uma-embed")?.append(container);
    const overflowX = getComputedStyle(code).overflowX;
    container.remove();
    return overflowX;
  });
  expect(markdownCodeOverflow).toBe("auto");
});

test("loads settings data only when its area is opened", async ({ page }) => {
  const paths: string[] = [];
  page.on("request", (request) => paths.push(new URL(request.url()).pathname));
  await register(page, true);
  await page.getByRole("button", { name: "会话设置" }).click();
  const settings = page.getByRole("dialog", { name: "会话设置" });
  await expect(settings.getByText("Agent Profile")).toBeVisible();
  expect(paths).not.toContain("/api/v15/tasks");
  expect(paths).not.toContain("/api/v15/schedules");
  expect(paths).not.toContain("/api/v15/knowledge");
  const tasks = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v15/tasks");
  await settings
    .getByRole("navigation", { name: "设置区域" })
    .getByRole("button", { name: "任务", exact: true })
    .click();
  expect((await tasks).ok()).toBe(true);
  await expect(settings.getByRole("heading", { name: "后台任务" })).toBeVisible();
  expect(paths).not.toContain("/api/v15/schedules");
  expect(paths).not.toContain("/api/v15/knowledge");
});
