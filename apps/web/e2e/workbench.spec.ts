import { expect, type Page, test } from "@playwright/test";

const ordinaryToken =
  "uma_pat_00000000-0000-4000-8000-000000000002_faux-user-2-token-012345678901234567890123";

test("quality tabs load and refresh only their own reports", async ({ page }) => {
  const paths: string[] = [];
  page.on("request", (request) => paths.push(new URL(request.url()).pathname));
  await login(page, "uma_pat_00000000-0000-4000-8000-000000000001_faux-local-token-012345678901234567890123");
  await destination(page, "质量");
  await expect.poll(() => paths.includes("/api/v16/reports/diagnostics")).toBe(true);
  expect(paths).not.toContain("/api/v16/evaluations");
  expect(paths).not.toContain("/api/v16/optimization-proposals");
  const changedWindow = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname === "/api/v16/reports/diagnostics" &&
      Number(url.searchParams.get("to")) - Number(url.searchParams.get("from")) === 7 * 86_400_000
    );
  });
  await page.getByLabel("诊断时间窗").selectOption("7");
  await changedWindow;
  await page.getByRole("button", { name: "评测历史", exact: true }).click();
  await expect.poll(() => paths.includes("/api/v16/evaluations")).toBe(true);
  expect(paths).not.toContain("/api/v16/optimization-proposals");
  const diagnosticsBefore = paths.filter((path) => path === "/api/v16/reports/diagnostics").length;
  const refreshed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/v16/evaluations",
  );
  await page.getByRole("button", { name: "刷新质量数据", exact: true }).click();
  await refreshed;
  expect(paths.filter((path) => path === "/api/v16/reports/diagnostics")).toHaveLength(diagnosticsBefore);
});

test("resource form cancellation preserves the independent skill draft", async ({ page }) => {
  await login(page, "uma_pat_00000000-0000-4000-8000-000000000001_faux-local-token-012345678901234567890123");
  await destination(page, "资源");
  await page.getByText("扫描本地技能目录", { exact: true }).click();
  await page.getByLabel("本地技能目录", { exact: true }).fill("skill-draft");
  await page.getByRole("button", { name: "添加目录", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("知识草稿");
  await page.getByLabel("服务器工作区路径", { exact: true }).fill("knowledge-draft");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page
    .getByRole("dialog", { name: "放弃未保存内容？" })
    .getByRole("button", { name: "放弃并离开" })
    .click();
  await expect(page.getByLabel("本地技能目录", { exact: true })).toHaveValue("skill-draft");
  await page.getByRole("button", { name: "添加目录", exact: true }).click();
  await expect(page.getByLabel("名称", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "放弃未保存内容？" })).toHaveCount(0);
});

test("ordinary resource upload is keyboard accessible and hides server directory actions", async ({
  page,
}) => {
  await login(page);
  await destination(page, "资源");
  await expect(page.getByRole("button", { name: "添加目录", exact: true })).toHaveCount(0);
  const upload = page.getByRole("button", { name: "上传知识文件", exact: true });
  await upload.focus();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  expect((await chooser).isMultiple()).toBe(false);
});

test("management drafts require an explicit discard before navigation", async ({ page }) => {
  await login(page);
  await destination(page, "后台任务");
  await page.getByText("新建后台任务", { exact: true }).click();
  await page.getByLabel("任务内容", { exact: true }).fill("保留待提交任务");
  await destination(page, "调度");
  const dialog = page.getByRole("dialog", { name: "放弃未保存内容？" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "继续编辑", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("任务内容", { exact: true })).toHaveValue("保留待提交任务");
  await destination(page, "调度");
  await dialog.getByRole("button", { name: "放弃并离开", exact: true }).click();
  await page.getByText("新建调度", { exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("未保存调度");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page.getByLabel("名称", { exact: true })).toHaveValue("未保存调度");
  await destination(page, "后台任务");
  await dialog.getByRole("button", { name: "放弃并离开", exact: true }).click();
  await page.getByText("新建后台任务", { exact: true }).click();
  await expect(page.getByLabel("任务内容", { exact: true })).toHaveValue("");
});

test("switches from Xianyu admin to a normal account without stopping the adapter", async ({ page }) => {
  const ordinary = { token: ordinaryToken };
  await page.context().clearCookies();
  const channelRequests: string[] = [];
  await page.route("**/api/v16/xianyu/**", async (route) => {
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
  await destination(page, "咸鱼工作台");
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
  const forbidden = await page.request.get("/api/v16/xianyu/status", {
    headers: { authorization: `Bearer ${ordinary.token}` },
  });
  expect(forbidden.status()).toBe(403);
});

async function login(page: Page, token = ordinaryToken): Promise<void> {
  await page.goto("/");
  await page.getByLabel("访问令牌").fill(token);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
}

async function openNavigation(page: Page) {
  await expect(page.locator(".app-shell")).toBeVisible();
  if ((page.viewportSize()?.width ?? 1280) < 840 && !(await page.locator(".sidebar").isVisible()))
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
}

async function destination(page: Page, name: string) {
  await openNavigation(page);
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  const button = nav.getByRole("button", { name, exact: true });
  if (!(await button.isVisible())) await nav.locator(".nav-more > summary").click();
  await button.click();
}

async function openSessionSettings(page: Page) {
  await openNavigation(page);
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: "会话设置", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "会话设置" })).toBeVisible();
  await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
}

test("assistant identity keeps an unsaved name when another device updates it", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "新会话", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "消息内容", exact: true })).toBeEnabled();
  let sessionId = "";
  page.on("request", (request) => {
    const match = new URL(request.url()).pathname.match(/\/sessions\/([^/]+)\/snapshot$/);
    if (match) sessionId = match[1];
  });
  await openSessionSettings(page);
  const input = page.getByLabel("助手名称", { exact: true });
  await input.fill("本机身份草稿");
  const sessions = await (await page.request.get("/api/v16/sessions")).json();
  const title = await page.locator(".workspace h1").textContent();
  sessionId ||= sessions.find((item: { title: string }) => item.title === title)?.id;
  expect(sessionId).toBeTruthy();
  const synchronized = page.waitForResponse(async (response) => {
    if (new URL(response.url()).pathname !== "/api/v16/sync/bootstrap" || !response.ok()) return false;
    const values = await response.json();
    return values.sessions.some(
      (item: { session: { id: string; assistantName: string } }) =>
        item.session.id === sessionId && item.session.assistantName === "远端身份",
    );
  });
  const changed = await page.request.patch(`/api/v16/sessions/${sessionId}`, {
    headers: { authorization: `Bearer ${ordinaryToken}` },
    data: { assistantName: "远端身份" },
  });
  expect(changed.ok()).toBeTruthy();
  // WebSocket 触发会话列表同步，必须让远端回执真正到达后再验证草稿。
  await synchronized;
  await expect(input).toHaveValue("本机身份草稿");
  await page.route(`**/api/v16/sessions/${sessionId}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "写入失败" } } });
  });
  await page.getByRole("button", { name: "保存身份", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("身份保存失败");
  await expect(input).toHaveValue("本机身份草稿");
});

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

  await expect(page.getByLabel("令牌名称")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "注册", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "继续进入" })).toBeDisabled();
  await page.getByLabel("我已手动保存令牌").check();
  await expect(page.getByRole("button", { name: "继续进入" })).toBeEnabled();
  await page.getByLabel("我已手动保存令牌").uncheck();
  await expect(page.getByRole("button", { name: "继续进入" })).toBeDisabled();
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
  const token = ordinaryToken;
  await login(first, token);
  await first.getByRole("button", { name: "新会话" }).click();
  await expect(first.getByPlaceholder("向 UmaAgent 发送消息")).toBeEnabled();
  await expect(first.locator(".nav-status-group button")).toHaveCount(3);
  await first.getByRole("button", { name: "会话设置" }).click();
  await expect(first.getByRole("dialog", { name: "会话设置" })).toBeVisible();
  await first.keyboard.press("Escape");
  await expect(first.getByRole("dialog", { name: "会话设置" })).toHaveCount(0);
  await expect(first.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true");
  await first.getByRole("button", { name: "Agent" }).click();
  await expect(first.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true");
  await first.getByLabel("会话更多操作").click();
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
  // 收纳后的消息操作仍可发现；Escape 恢复焦点，复制拒绝不能显示假成功。
  const userMessage = first.locator(".message-row--user").last();
  const messageMenu = userMessage.getByLabel("消息更多操作");
  await messageMenu.click();
  await expect(userMessage.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
  await first.keyboard.press("Escape");
  await expect(messageMenu).toBeFocused();
  await expect(userMessage.locator("details")).not.toHaveAttribute("open", "");
  await messageMenu.click();
  await userMessage.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(userMessage.locator("textarea")).toHaveValue("multi device hello");
  await userMessage.getByRole("button", { name: "取消", exact: true }).click();
  await first.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) },
    });
  });
  await userMessage.getByRole("button", { name: "复制", exact: true }).click();
  await expect(userMessage.getByText("复制失败，请选择正文后手动复制。")).toBeVisible();
  await expect(userMessage.getByRole("button", { name: "已复制", exact: true })).toHaveCount(0);
  const desktopAvatar = await first
    .locator(".message-avatar")
    .first()
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
  expect(desktopAvatar).toEqual({ width: 48, height: 48 });

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
  expect(mobileAvatar).toEqual({ width: 38, height: 38 });
  for (const [area, heading] of [
    ["后台任务", "后台任务"],
    ["记忆", "记忆"],
    ["调度", "调度"],
    ["资源", "知识库"],
  ]) {
    await destination(first, area);
    const body = first.locator(".destination-body");
    await expect(body.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(body.locator(".settings-section--operation")).toHaveCount(1);
    const widths = await body
      .locator(".settings-section--operation")
      .evaluateAll((sections) =>
        sections.map((section) => ({ scrollWidth: section.scrollWidth, clientWidth: section.clientWidth })),
      );
    expect(widths.every(({ scrollWidth, clientWidth }) => scrollWidth <= clientWidth)).toBe(true);
  }
  await openSessionSettings(first);
  const settings = first.getByRole("dialog", { name: "会话设置" });
  await expect(settings.getByRole("heading", { name: "当前会话", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "后台任务", exact: true })).toHaveCount(0);
  await first.keyboard.press("Escape");
  await destination(first, "设置");
  await first.locator(".destination-body").getByRole("button", { name: "退出登录", exact: true }).click();
  await first
    .getByRole("dialog", { name: "退出登录并清理本设备缓存？" })
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(first.getByLabel("访问令牌")).toBeVisible();
  await expect(first.getByPlaceholder("向 UmaAgent 发送消息")).toHaveCount(0);

  await firstContext.close();
  await secondContext.close();
});

test("pastes an image into the composer and sends it as an attachment", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "新会话" }).click();
  const input = page.getByPlaceholder("向 UmaAgent 发送消息");
  await expect(input).toBeEnabled();
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
  await login(page);
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name: "新会话" }).click();
  const input = page.getByPlaceholder("向 UmaAgent 发送消息");
  const transcript = page.locator(".transcript");

  for (let index = 0; index < 4; index += 1) {
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

  await openSessionSettings(page);
  const settings = page.getByRole("dialog", { name: "会话设置" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("heading", { name: "当前会话" })).toBeVisible();
  await expect(settings.getByText("Agent Profile")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await destination(page, "设置");
  const account = page.locator(".destination-body");
  await expect(account.getByText("Agent Profile")).toBeVisible();
  await expect(account.getByText("应用与诊断")).toBeVisible();
  await expect(account.getByText("账号操作")).toBeVisible();
  await expect(account.getByRole("heading", { name: "当前会话", exact: true })).toHaveCount(0);

  const fontStyles = await account.getByRole("button", { name: "保存 Profile" }).evaluate((button) => {
    const style = getComputedStyle(button);
    return {
      family: style.fontFamily,
      size: style.fontSize,
      weight: style.fontWeight,
      lineHeight: style.lineHeight,
    };
  });
  await expect(account.getByRole("button", { name: "重新加载配置" })).toHaveCount(0);
  const secondaryStyles = await account.getByRole("button", { name: "退出登录" }).evaluate((button) => {
    const style = getComputedStyle(button);
    return {
      family: style.fontFamily,
      size: style.fontSize,
      weight: style.fontWeight,
      lineHeight: style.lineHeight,
    };
  });
  expect(fontStyles).toEqual(secondaryStyles);
  await account.getByLabel("Profile 内容").fill("保持简洁并先说明风险。");
  await account.getByRole("button", { name: "保存 Profile" }).click();
  await expect(account.getByText("Profile 已同步到当前账号。")).toBeVisible();
});

test("keeps tool output collapsed until requested", async ({ page }) => {
  await login(page);
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
  await login(page);
  await openSessionSettings(page);
  const settings = page.getByRole("dialog", { name: "会话设置" });
  await expect(settings.getByRole("heading", { name: "当前会话", exact: true })).toBeVisible();
  expect(paths).not.toContain("/api/v16/tasks");
  expect(paths).not.toContain("/api/v16/schedules");
  expect(paths).not.toContain("/api/v16/knowledge");
  await page.keyboard.press("Escape");
  const tasks = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v16/tasks");
  await destination(page, "后台任务");
  expect((await tasks).ok()).toBe(true);
  await expect(page.locator(".destination-body").getByRole("heading", { name: "后台任务" })).toBeVisible();
  expect(paths).not.toContain("/api/v16/schedules");
  expect(paths).not.toContain("/api/v16/knowledge");
  await openSessionSettings(page);
  await expect(settings.getByRole("heading", { name: "当前会话" })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "后台任务" })).toHaveCount(0);
});

test("conversation and settings retain their layout across widths and themes", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "新会话", exact: true }).click();
  const input = page.getByPlaceholder("向 UmaAgent 发送消息");
  await expect(input).toBeEnabled();
  await input.fill(
    "布局验收 " +
      "长路径/".repeat(55) +
      "\n\n```ts\nconst value = 42;\n```\n\n|列一|列二|\n|---|---|\n|长文本|内容|",
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".response-card .markdown").first()).toContainText(
    "Faux Core received: 布局验收",
  );
  for (const dark of [false, true]) {
    await destination(page, "设置");
    await page.getByLabel(dark ? "深色" : "浅色", { exact: true }).check();
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [840, 900],
      [390, 844],
      [320, 640],
    ]) {
      await page.setViewportSize({ width, height });
      await destination(page, "会话");
      await expect(page.locator(".response-card .markdown").first()).toBeVisible();
      const geometry = await page.locator("[data-design-shell]").evaluate((root) => {
        const row = root.querySelector<HTMLElement>(".message-row")!;
        const avatar = row.querySelector<HTMLElement>(".message-avatar")!;
        const composer = root.querySelector<HTMLElement>(".composer")!;
        return {
          width: root.scrollWidth,
          height: root.scrollHeight,
          clientHeight: root.clientHeight,
          row: row.getBoundingClientRect().width,
          gap: parseFloat(getComputedStyle(row).columnGap),
          avatar: avatar.getBoundingClientRect().width,
          composerBottom: composer.getBoundingClientRect().bottom,
          bodyFont: getComputedStyle(root.querySelector(".markdown")!).fontSize,
        };
      });
      expect(geometry.width).toBeLessThanOrEqual(width);
      expect(geometry.height).toBeLessThanOrEqual(geometry.clientHeight);
      expect(geometry.row).toBeLessThanOrEqual(960);
      expect(geometry.avatar).toBe(width < 840 ? 38 : 48);
      expect(geometry.gap).toBeGreaterThanOrEqual(10);
      expect(geometry.bodyFont).toBe("16px");
      expect(geometry.composerBottom).toBeLessThanOrEqual(height);
      await page.screenshot({ path: `artifacts/refactor/chat-${width}-${dark ? "dark" : "light"}.png` });
      await openSessionSettings(page);
      const summary = page.locator(".status-summary");
      await expect(summary).toBeVisible();
      const card = await summary.evaluate((el) => ({
        padding: parseFloat(getComputedStyle(el).paddingLeft),
        width: el.clientWidth,
        scroll: el.scrollWidth,
      }));
      const bounds = await page.locator(".settings-section").first().boundingBox();
      const dialogBounds = await page.getByRole("dialog", { name: "会话设置" }).boundingBox();
      if (!bounds || !dialogBounds) throw new Error("settings layout missing");
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(dialogBounds.x + dialogBounds.width - 16);
      expect(card.padding).toBeGreaterThanOrEqual(16);
      expect(card.scroll).toBeLessThanOrEqual(card.width);
      await page.screenshot({
        path: `artifacts/refactor/session-settings-${width}-${dark ? "dark" : "light"}.png`,
      });
      await page.keyboard.press("Escape");
    }
  }
});

test("unsaved account Profile survives navigation and failed sends retain the draft", async ({ page }) => {
  await login(page);
  await destination(page, "设置");
  const draft = "未保存的 Profile 草稿";
  await page.getByLabel("Profile 内容").fill(draft);
  await destination(page, "后台任务");
  const confirmation = page.getByRole("dialog", { name: "放弃未保存内容？" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page.getByLabel("Profile 内容")).toHaveValue(draft);
  await expect(page.getByText("有未保存的修改")).toBeVisible();
  await destination(page, "会话");
  await confirmation.getByRole("button", { name: "放弃并离开", exact: true }).click();
  await page.getByRole("button", { name: "新会话", exact: true }).click();
  const input = page.getByPlaceholder("向 UmaAgent 发送消息");
  await expect(input).toBeEnabled();
  let writes = 0;
  await page.route("**/api/v16/sessions/*/messages", async (route) => {
    writes++;
    await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "暂时无法提交" } } });
  });
  await input.fill("失败后仍保留这条草稿");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "核对会话记录" })).toBeVisible();
  await expect(input).toHaveValue("失败后仍保留这条草稿");
  await page.getByRole("button", { name: "核对会话记录" }).click();
  expect(writes).toBe(1);
});
