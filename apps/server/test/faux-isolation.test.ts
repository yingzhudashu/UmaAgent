import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("refuses an existing Faux database without resetting historical files", async () => {
  const root = await mkdtemp(join(tmpdir(), "uma-faux-preserve-"));
  const database = Buffer.from("existing database must remain byte-for-byte unchanged");
  await writeFile(join(root, "state.db"), database);
  await writeFile(join(root, "user-file.txt"), "历史用户数据");
  const child = spawn(process.execPath, [resolve("scripts/faux-server.mjs")], {
    env: { ...process.env, UMA_FAUX_STATE: root, UMA_FAUX_RESET_STATE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  // 即使有人遗留了旧环境变量，也必须拒绝既有数据库，不能重新启用删除路径。
  const watchdog = setTimeout(() => child.kill(), 5000);
  try {
    const status = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("exit", done);
    });
    expect(status).toBe(1);
    expect(stderr).toContain("existing database was not modified");
    expect((await readFile(join(root, "state.db"))).equals(database)).toBe(true);
    expect(await readFile(join(root, "user-file.txt"), "utf8")).toBe("历史用户数据");
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
});
