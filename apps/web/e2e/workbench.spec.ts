import { expect, type Page, test } from "@playwright/test";

async function register(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "创建新账户" }).click();
  await page.getByLabel("令牌名称").fill("e2e");
  await page.getByRole("button", { name: "注册并进入" }).click();
  const text = await page.locator(".token-result").textContent();
  const token = text?.match(/uma_pat_[A-Za-z0-9_-]+/)?.[0];
  if (!token) throw new Error("Registration did not return a personal token");
  await page.getByRole("button", { name: "继续进入" }).click();
  await expect(page.getByText("Core online")).toBeVisible();
  return token;
}

async function login(page: Page, token: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("访问令牌").fill(token);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("Core online")).toBeVisible();
}

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

  await secondContext.setOffline(true);
  await expect(second.getByPlaceholder("向 UmaAgent 发送消息")).toBeDisabled();
  await expect(second.getByText("Faux Core received: multi device hello")).toBeVisible();
  await firstContext.close();
  await secondContext.close();
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
  await expect(settings.getByText("当前会话")).toBeVisible();
  await expect(settings.getByText("Agent Profile")).toBeVisible();
  await expect(settings.getByText("应用与诊断")).toBeVisible();
  await expect(settings.getByText("账号操作")).toBeVisible();

  const fontStyles = await settings.locator(".settings-primary").evaluate((button) => {
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
  await register(page);
  await page.getByRole("button", { name: "新会话" }).click();
  await page.getByRole("button", { name: "Agent" }).click();
  const input = page.getByPlaceholder("向 UmaAgent 发送消息");
  await input.fill("Use the configured deterministic read tool and report its result.");
  await page.getByRole("button", { name: "发送" }).click();
  const tool = page.locator(".tool-details").first();
  await expect(tool).toBeVisible();
  await expect(tool).not.toHaveAttribute("open", "");
  await tool.locator("summary").click();
  await expect(tool).toHaveAttribute("open", "");
});
