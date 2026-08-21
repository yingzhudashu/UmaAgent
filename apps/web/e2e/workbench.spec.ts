import { expect, type Page, test } from "@playwright/test";

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("访问令牌").fill("uma-dev-token");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("Core online")).toBeVisible();
}

test("two devices converge on one session and offline mode is read-only", async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  await login(first);
  await first.getByRole("button", { name: "助手会话" }).click();
  await expect(first.getByPlaceholder("向 UmaAgent 发送消息")).toBeEnabled();

  await login(second);
  await expect(second.getByRole("button", { name: /助手 · New session/ }).first()).toBeVisible();
  await second
    .getByRole("button", { name: /助手 · New session/ })
    .first()
    .click();

  await first.getByPlaceholder("向 UmaAgent 发送消息").fill("multi device hello");
  await first.getByRole("button", { name: "发送" }).click();
  await expect(first.getByText("Faux Core received: multi device hello")).toBeVisible();
  await expect(second.getByText("Faux Core received: multi device hello")).toBeVisible();

  await first.getByRole("button", { name: "schedules", exact: true }).click();
  await second.getByRole("button", { name: "schedules", exact: true }).click();
  await first.getByRole("button", { name: "新建调度" }).click();
  await first.getByLabel("名称").fill("cross-device schedule");
  await first.getByLabel("任务").fill("resource invalidation check");
  await first.getByRole("button", { name: "创建", exact: true }).click();
  await expect(first.getByText("cross-device schedule")).toBeVisible();
  await expect(second.getByText("cross-device schedule")).toBeVisible();

  await secondContext.setOffline(true);
  await expect(second.getByPlaceholder("向 UmaAgent 发送消息")).toBeDisabled();
  await expect(second.getByText("Faux Core received: multi device hello")).toBeVisible();
  await firstContext.close();
  await secondContext.close();
});
