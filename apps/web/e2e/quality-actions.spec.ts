import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const api = "/api/v16";
const token = "uma_pat_00000000-0000-4000-8000-000000000003_faux-user-3-token-012345678901234567890123";

test("review and improve actions expose progress, failures and the generated answer", async ({ page }) => {
  const headers = { authorization: `Bearer ${token}` };
  const created = await page.request.post(`${api}/sessions`, {
    headers,
    data: { title: `质量操作 ${randomUUID()}` },
  });
  expect(created.ok()).toBe(true);
  const session = await created.json();
  const sent = await page.request.post(`${api}/sessions/${session.id}/messages`, {
    headers,
    data: { messageId: randomUUID(), text: "质量操作验收消息", mode: "agent" },
  });
  expect(sent.ok()).toBe(true);

  await page.context().clearCookies();
  await page.goto("/");
  await page.getByLabel("访问令牌").fill(token);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
  await page.locator(".session-list button").filter({ hasText: session.title }).click();
  const answer = page.locator("article").filter({ hasText: "Faux Core received: 质量操作验收消息" });
  await expect(answer).toHaveCount(1);

  let releaseReview!: () => void;
  const reviewGate = new Promise<void>((resolve) => {
    releaseReview = resolve;
  });
  await page.route(`**${api}/messages/*/review`, async (route) => {
    await reviewGate;
    await route.continue();
  });
  await answer.getByLabel("回复更多操作").click();
  await answer.getByRole("button", { name: "审查", exact: true }).click();
  await expect(answer.getByText("正在提交任务…", { exact: true })).toBeVisible();
  releaseReview();
  await expect(answer.getByText("Faux review issue", { exact: true })).toBeVisible();

  await answer.getByLabel("回复更多操作").click();
  await answer.getByRole("button", { name: "改进", exact: true }).click();
  await expect(answer.getByText("正在提交任务…", { exact: true })).toBeVisible();
  await expect(answer.getByText("Faux improved answer", { exact: true })).toBeVisible();
});
