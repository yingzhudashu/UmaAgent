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
  await expect(first.getByRole("button", { name: "Ask" })).toHaveAttribute("aria-pressed", "true");
  await first.getByRole("button", { name: "Agent" }).click();
  await expect(first.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true");

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
