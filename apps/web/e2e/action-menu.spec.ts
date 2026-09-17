import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// 独立账号避免并行测试中新会话抢走其他用例的默认选中会话，也不消耗注册限额。
const token = "uma_pat_00000000-0000-4000-8000-000000000004_faux-user-4-token-012345678901234567890123";

for (const embedded of [false, true]) {
  for (const width of [320, 390, 1280]) {
    test(`conversation menu is reachable at ${width}px in ${embedded ? "embed" : "standalone"}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      if (embedded) {
        // 使用真正的发布入口及 CSS，避免只测独立页面而漏掉宿主嵌入问题。
        await page.route("**/menu-embed", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<link rel="stylesheet" href="/menu-assets/uma-embed.css"><div id="mount"></div>
              <script type="module">import { mountUmaAgent } from '/menu-assets/uma-embed.js';
              mountUmaAgent(document.getElementById('mount'));</script>`,
          }),
        );
        await page.route("**/menu-assets/*", async (route) => {
          const name = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
          expect(name).toMatch(/^[\w.-]+$/);
          await route.fulfill({
            body: await readFile(resolve("apps/web/dist-embed", name)),
            contentType: name.endsWith(".js")
              ? "text/javascript"
              : name.endsWith(".css")
                ? "text/css"
                : "application/octet-stream",
          });
        });
      }
      const created = await page.request.post("/api/v16/sessions", {
        headers: { authorization: `Bearer ${token}` },
        data: { title: "菜单布局回归：".repeat(12) },
      });
      expect(created.ok()).toBe(true);
      await page.goto(embedded ? "/menu-embed" : "/");
      await page.getByLabel("访问令牌").fill(token);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      const trigger = page.getByLabel("会话更多操作", { exact: true });
      const menu = page.locator(".header-actions .action-menu");
      await trigger.click();
      await expect(menu).toHaveAttribute("open", "");
      const actions = menu.getByRole("button");
      await expect(actions).toHaveCount(5);
      for (const action of await actions.all()) {
        // toBeVisible 只检查布局盒；命中测试同时发现祖先裁切和其他元素遮挡。
        await expect(action).toBeInViewport();
        expect(
          await action.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
          }),
        ).toBe(true);
        await action.click({ trial: true });
      }
      await testInfo.attach("expanded-menu", { body: await page.screenshot(), contentType: "image/png" });
      expect(await page.locator(".uma-embed").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await menu.getByRole("button", { name: "快捷命令", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "快捷命令", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).not.toHaveAttribute("open", "");
      await trigger.press("ArrowDown");
      await expect(menu.getByRole("button", { name: "快捷命令", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(menu).not.toHaveAttribute("open", "");
      await trigger.click();
      await page.getByRole("textbox", { name: "消息内容", exact: true }).click();
      await expect(menu).not.toHaveAttribute("open", "");
    });
  }
}
