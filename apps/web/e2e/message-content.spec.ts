import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { expect, test } from "@playwright/test";

test("the packaged Android body renders math safely and preserves completed blocks while streaming", async ({
  page,
}) => {
  const assets = resolve("android/app/src/main/assets/message");
  await page.route("https://appassets.androidplatform.net/assets/message/**", async (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const path = resolve(assets, pathname.slice("/assets/message/".length));
    if (!path.startsWith(`${assets}${sep}`)) return route.abort();
    const types: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
    };
    try {
      await route.fulfill({
        body: await readFile(path),
        contentType: types[extname(path)] ?? "application/octet-stream",
      });
    } catch {
      await route.fulfill({ status: 404, body: "Missing fixture" });
    }
  });
  await page.addInitScript(() => {
    Reflect.set(window, "UmaBody", {
      height: () => {},
      ready: () => {},
      copy: (value: string) => Reflect.set(window, "copied", value),
      attachment: (id: string) => Reflect.set(window, "attachment", id),
      image: () => {},
    });
  });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("https://appassets.androidplatform.net/assets/message/android.html");
  await page.waitForFunction(() => typeof Reflect.get(window, "updateMessage") === "function");
  const content =
    "# 标题\n\n正文 **强调** $a^2$。\n\n> 引用\n\n- 一级\n  - 二级\n\n| 列 | 长内容 |\n| --- | --- |\n| 数据 | " +
    "表格内容".repeat(40) +
    " |\n\n```js\nconst formula = '$notMath$';\n" +
    "longCode".repeat(50) +
    "\n```\n\n[下载](uma-attachment://attachment-1)\n\n<script>window.injected=1</script><img src=x onerror='window.injected=1'><a href='javascript:alert(1)'>坏链接</a>\n\n$$\\frac{1}{2}$$";
  const render = (text: string) =>
    page.evaluate((text) => {
      Reflect.get(window, "updateMessage")(text, {
        text: "#17212b",
        background: "#ffffff",
        link: "#365f45",
        size: 16,
        code: "#eeeeee",
      });
    }, text);
  await render(content);
  await expect(page.locator("h1")).toHaveText("标题");
  await expect(page.locator(".katex")).toHaveCount(2);
  await expect(page.locator("pre .katex")).toHaveCount(0);
  await expect(page.locator("ul ul li")).toHaveText("二级");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => Reflect.get(window, "injected"))).toBeUndefined();
  await expect(page.locator("#message script, #message [onerror], a[href^='javascript:']")).toHaveCount(0);
  await page.getByRole("button", { name: "复制代码" }).click();
  expect(await page.evaluate(() => Reflect.get(window, "copied"))).toContain("$notMath$");
  await page.evaluate(() => {
    Reflect.get(window, "UmaBody").copy = () => false;
  });
  await page.getByRole("button", { name: "已复制", exact: true }).click();
  await expect(page.getByRole("button", { name: "复制失败，请选择文本复制" })).toBeVisible();
  await page.getByRole("link", { name: "下载" }).click();
  expect(await page.evaluate(() => Reflect.get(window, "attachment"))).toBe("attachment-1");
  await page.evaluate(() => {
    Reflect.set(window, "headingBefore", document.querySelector("h1"));
    Reflect.set(window, "imageBefore", document.querySelector("#message img"));
    Reflect.set(window, "copyBefore", document.querySelector(".code-copy"));
    document.querySelector("#message img")?.dispatchEvent(new Event("error"));
  });
  await render(`${content}\n\n新段落`);
  expect(
    await page.evaluate(() => Reflect.get(window, "headingBefore") === document.querySelector("h1")),
  ).toBe(true);
  expect(
    await page.evaluate(() => Reflect.get(window, "imageBefore") === document.querySelector("#message img")),
  ).toBe(true);
  expect(
    await page.evaluate(() => Reflect.get(window, "copyBefore") === document.querySelector(".code-copy")),
  ).toBe(true);
  await expect(page.getByRole("button", { name: "复制失败，请选择文本复制" })).toBeVisible();
  await page.screenshot({ path: "artifacts/acceptance/shared-body-320.png", fullPage: true });
});
