import { expect, test } from "@playwright/test";

test("200 percent text keeps the mobile composer and settings within their surfaces", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByLabel("访问令牌")
    .fill("uma_pat_00000000-0000-4000-8000-000000000003_faux-user-3-token-012345678901234567890123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("button", { name: "新会话", exact: true }).click();
  const input = page.getByPlaceholder("向 UmaAgent 发送消息");
  await expect(input).toBeEnabled();
  await input.fill("200% 字号与长文本布局验收");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".response-card")).toContainText("已完成");
  await input.fill("放大字号下的待发送草稿");
  // Scale the actual computed text metrics, including controls that use px.
  const enlarge = async () =>
    page.locator("[data-design-shell]").evaluate((root) => {
      const nodes = [...root.querySelectorAll<HTMLElement>("*")];
      const metrics = nodes.map((node) => ({
        node,
        font: parseFloat(getComputedStyle(node).fontSize),
        line: parseFloat(getComputedStyle(node).lineHeight),
      }));
      for (const { node, font, line } of metrics) {
        node.style.fontSize = `${font * 2}px`;
        if (Number.isFinite(line)) node.style.lineHeight = `${line * 2}px`;
      }
    });
  await enlarge();
  await expect(input).toBeVisible();
  const bounds = await input.boundingBox();
  expect(bounds?.width).toBeGreaterThan(160);
  const navigation = await page.getByRole("navigation", { name: "移动主导航", exact: true }).boundingBox();
  expect(navigation).not.toBeNull();
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(navigation?.y ?? 0);
  for (const button of await page.locator(".composer > button").all()) {
    const buttonBounds = await button.boundingBox();
    expect(buttonBounds).not.toBeNull();
    expect((buttonBounds?.y ?? 0) + (buttonBounds?.height ?? 0)).toBeLessThanOrEqual(navigation?.y ?? 0);
    await button.click({ trial: true });
  }
  await page.screenshot({ path: "artifacts/refactor/chat-390-text-200.png" });
  // Reload removes the simulated text overrides; test account settings independently.
  await page.reload();
  await page
    .getByRole("navigation", { name: "移动主导航", exact: true })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await expect(page.getByLabel("Profile 内容")).toBeVisible();
  await enlarge();
  const widths = await page
    .locator(".destination-body")
    .evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  await page.screenshot({ path: "artifacts/refactor/settings-390-text-200.png" });
});
