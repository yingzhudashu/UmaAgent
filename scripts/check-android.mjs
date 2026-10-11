import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const wrapper = resolve("android", process.platform === "win32" ? "gradlew.bat" : "gradlew");
if (!existsSync(wrapper)) throw new Error(`Android Gradle wrapper is missing: ${wrapper}`);

const args = [":app:testDebugUnitTest", ":app:compileDebugAndroidTestKotlin", "--no-daemon"];
const code = await new Promise((resolveCode, reject) => {
  const windows = process.platform === "win32";
  const child = windows
    ? // `cmd /s /c` treats a fully quoted command string as one executable name on
      // Windows. Pass the wrapper and task arguments as separate argv entries so
      // paths with spaces and Gradle's batch wrapper are handled consistently.
      spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "call", wrapper, ...args], {
        cwd: resolve("android"),
        stdio: "inherit",
      })
    : spawn(wrapper, args, { cwd: resolve("android"), stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (exitCode, signal) => resolveCode(exitCode ?? (signal ? 1 : 0)));
});
if (code !== 0) process.exitCode = code;
