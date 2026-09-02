import { expect, type Page, test } from "@playwright/test";

let sharedToken: string | undefined;

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
  await expect(settings.getByRole("heading", { name: "后台任务" })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "记忆" })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "调度" })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "知识库" })).toBeVisible();
  await expect(settings.locator(".settings-section--operation")).toHaveCount(4);
  await expect(settings.locator(".settings-section--operation .settings-panel--nested")).toHaveCount(0);
  const widths = await settings.locator(".settings-section--operation").evaluateAll((sections) =>
    sections.map((section) => {
      const style = getComputedStyle(section);
      return {
        scrollWidth: section.scrollWidth,
        clientWidth: section.clientWidth,
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(
          Number.parseFloat,
        ),
      };
    }),
  );
  expect(widths.every(({ scrollWidth, clientWidth }) => scrollWidth <= clientWidth)).toBe(true);
  expect(widths.every(({ padding }) => padding.every((value) => value >= 12))).toBe(true);
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
  await register(page);
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
  await expect(steps).toBeVisible();
  await expect(steps).not.toHaveAttribute("open", "");
  await steps.locator(":scope > summary").click();
  await expect(steps).toHaveAttribute("open", "");
  const tool = page.locator(".tool-details").first();
  await expect(tool).toBeVisible();
  await expect(tool).not.toHaveAttribute("open", "");
  await tool.locator("summary").click();
  await expect(tool).toHaveAttribute("open", "");
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
