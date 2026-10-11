import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const api = "/api/v16";
const token = "uma_pat_00000000-0000-4000-8000-000000000003_faux-user-3-token-012345678901234567890123";

test("assistant responses no longer expose review or improve actions", async ({ page }) => {
  const headers = { authorization: `Bearer ${token}` };
  const created = await page.request.post(`${api}/sessions`, {
    headers,
    data: { title: `回复操作 ${randomUUID()}` },
  });
  expect(created.ok()).toBe(true);
  const session = await created.json();
  const sent = await page.request.post(`${api}/sessions/${session.id}/messages`, {
    headers,
    data: { messageId: randomUUID(), text: "检查回复操作菜单", mode: "agent" },
  });
  expect(sent.ok()).toBe(true);

  await page.context().clearCookies();
  await page.goto("/");
  await page.getByLabel("访问令牌").fill(token);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
  await page.locator(".session-list button").filter({ hasText: session.title }).click();

  const response = page.locator(".response-card").filter({ hasText: "Faux Core received: 检查回复操作菜单" });
  await expect(response).toHaveCount(1);
  await expect(response.getByRole("button", { name: "审查", exact: true })).toHaveCount(0);
  await expect(response.getByRole("button", { name: "改进", exact: true })).toHaveCount(0);
  await expect(response.getByLabel("回复更多操作")).toHaveCount(0);
});
