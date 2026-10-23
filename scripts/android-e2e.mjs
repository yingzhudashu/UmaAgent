import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { freemem, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import {
  allowedConditionalSkips,
  mergeInstrumentation,
  parseInstrumentation,
} from "./android-instrumentation.mjs";

const windows = process.platform === "win32";
const sdk =
  process.env.ANDROID_SDK_ROOT ??
  process.env.ANDROID_HOME ??
  (windows && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : undefined);
const adb = sdk ? join(sdk, "platform-tools", windows ? "adb.exe" : "adb") : "adb";
function adbCommand(args, timeout = 600_000) {
  const result = spawnSync(adb, args, { encoding: "utf8", timeout, maxBuffer: 20 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const error = result.error ?? new Error(`adb failed (${result.status}): ${result.stderr}`);
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}
const devices = adbCommand(["devices"])
  .split(/\r?\n/)
  .filter((line) => /\tdevice$/.test(line))
  .map((line) => line.split("\t")[0]);
const serial = process.env.UMA_ANDROID_DEVICE?.trim() || (devices.length === 1 ? devices[0] : undefined);
if (!serial || !devices.includes(serial) || !serial.startsWith("emulator-"))
  throw new Error(
    "Select one connected emulator with UMA_ANDROID_DEVICE; this debug test never targets a real user device.",
  );
const device = (...args) => adbCommand(["-s", serial, ...args]);
/** 长时间 instrumentation 不能阻塞父进程，否则 Faux 的日志管道无法持续排空。 */
async function instrumentDevice(args) {
  const child = spawn(adb, ["-s", serial, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let overflow = false;
  let receivedBytes = 0;
  const collect = (stream, append) =>
    stream.on("data", (chunk) => {
      receivedBytes += Buffer.byteLength(chunk, "utf8");
      if (receivedBytes > 20 * 1024 * 1024) {
        overflow = true;
        child.kill();
      } else append(chunk);
    });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  collect(child.stdout, (value) => {
    stdout += value;
  });
  collect(child.stderr, (value) => {
    stderr += value;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 600_000);
  try {
    const [code, signal] = await once(child, "close");
    if (code !== 0 || signal || timedOut || overflow) {
      const error = new Error(
        `Instrumentation command failed (${code}, ${signal}, timeout=${timedOut}, overflow=${overflow})`,
      );
      error.stdout = stdout;
      error.stderr = stderr;
      throw error;
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}
const stateDir = await mkdtemp(join(tmpdir(), "uma-android-e2e-"));
const evidenceDir = resolve("artifacts/acceptance", `android-e2e-${Date.now()}`);
await mkdir(evidenceDir, { recursive: true });
const startTimestamp = new Date().toISOString();
const result = {
  passed: false,
  serial,
  startTimestamp,
  environment: { hostAvailableMemoryBytes: freemem(), hostTotalMemoryBytes: totalmem() },
  cleanupErrors: [],
};
let previousIme;
let server;
let serverLog;
async function stopServer() {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null) return;
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  let timer;
  await Promise.race([
    exited,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Faux shutdown timed out")), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
}
try {
  previousIme = device("shell", "settings", "get", "secure", "show_ime_with_hard_keyboard").trim();
  result.api = device("shell", "getprop", "ro.build.version.sdk").trim();
  result.environment.device = {
    fingerprint: device("shell", "getprop", "ro.build.fingerprint").trim(),
    memory: device("shell", "cat", "/proc/meminfo"),
    cpuPresent: device("shell", "cat", "/sys/devices/system/cpu/present").trim(),
    display: device("shell", "wm", "size") + device("shell", "wm", "density"),
    fontScale: device("shell", "settings", "get", "system", "font_scale").trim(),
    webview: device("shell", "dumpsys", "webviewupdate"),
    // 记录设备实际使用的 GLES 后端，避免把不同模拟器图形路径的结果直接比较。
    graphics: device("shell", "dumpsys", "SurfaceFlinger")
      .split(/\r?\n/)
      .filter((line) => line.includes("GLES:"))
      .join("\n"),
  };
  // Gradle 退出后才启动设备测试，性能阶段独立执行，保留原有阈值。
  const wrapper = resolve("android", windows ? "gradlew.bat" : "gradlew");
  const buildArgs = [":app:assembleDebug", ":app:assembleDebugAndroidTest", "--no-daemon"];
  const build = windows
    ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "call", wrapper, ...buildArgs], {
        cwd: resolve("android"),
        stdio: "inherit",
      })
    : spawn(wrapper, buildArgs, { cwd: resolve("android"), stdio: "inherit" });
  const [buildCode] = await once(build, "exit");
  if (buildCode !== 0) throw new Error(`Android build failed (${buildCode})`);
  device("install", "-r", resolve("android/app/build/outputs/apk/debug/app-debug.apk"));
  device(
    "install",
    "-r",
    resolve("android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"),
  );
  device("shell", "settings", "put", "secure", "show_ime_with_hard_keyboard", "1");
  result.apks = [];
  for (const [packageId, file] of [
    ["site.robotclaw.umaagent.debug", "android/app/build/outputs/apk/debug/app-debug.apk"],
    [
      "site.robotclaw.umaagent.debug.test",
      "android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
    ],
  ]) {
    const sha256 = createHash("sha256")
      .update(await readFile(resolve(file)))
      .digest("hex");
    const installedPath = device("shell", "pm", "path", packageId)
      .trim()
      .replace(/^package:/, "");
    const installedSha256 = device("shell", "sha256sum", installedPath).trim().split(/\s+/)[0];
    result.apks.push({ packageId, sha256, installedSha256 });
    if (sha256 !== installedSha256) throw new Error(`Installed APK differs from build: ${packageId}`);
  }
  serverLog = createWriteStream(join(evidenceDir, "faux.log"));
  server = spawn(process.execPath, ["--max-semi-space-size=4", "scripts/faux-server.mjs"], {
    env: { ...process.env, UMA_FAUX_STATE: stateDir, UMA_FAUX_PORT: "33210" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let startupError;
  let bootOutput = "";
  server.stdout.on("data", (chunk) => {
    bootOutput = (bootOutput + chunk).slice(-4096);
  });
  server.once("error", (error) => {
    startupError = error;
  });
  server.stdout.pipe(serverLog, { end: false });
  server.stderr.pipe(serverLog, { end: false });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (startupError) throw startupError;
    if (server.exitCode !== null) throw new Error(`Faux exited (${server.exitCode})`);
    try {
      ready =
        bootOutput.includes("UmaAgent faux server:") &&
        (await fetch("http://127.0.0.1:33210/api/v16/health/ready", { signal: AbortSignal.timeout(1000) }))
          .ok;
    } catch {
      /* 等待本次独有服务就绪。 */
    }
    if (ready) break;
    await new Promise((done) => setTimeout(done, 250));
  }
  if (!ready) throw new Error("Isolated Android Faux did not become ready");
  const packageName = "site.robotclaw.umaagent.debug.test/androidx.test.runner.AndroidJUnitRunner";
  const performanceClass = "site.robotclaw.umaagent.BodyPerformanceTest";
  const instrument = async (filter, name, expected, discovery = false, extra = []) => {
    // AndroidJUnitRunner 会重启目标应用，但 EmptyActivity 位于测试包自己的进程。
    // 上一阶段已经正常结束后再停止该辅助进程，避免冻结的旧窗口跨阶段参与焦点交接。
    device("shell", "am", "force-stop", "site.robotclaw.umaagent.debug.test");
    let output;
    try {
      output = await instrumentDevice([
        "shell",
        "am",
        "instrument",
        "-w",
        "-r",
        ...(discovery ? ["-e", "log", "true"] : []),
        ...extra,
        "-e",
        ...filter,
        packageName,
      ]);
    } catch (error) {
      await writeFile(join(evidenceDir, `${name}.log`), error.stdout ?? "");
      await writeFile(join(evidenceDir, `${name}.stderr.log`), error.stderr ?? String(error));
      throw error;
    }
    process.stdout.write(output);
    await writeFile(join(evidenceDir, `${name}.log`), output);
    const parsed = parseInstrumentation(output, expected, allowedConditionalSkips);
    if (!parsed.passed) {
      // 故障现场随失败方法归档，下一方法会重启应用，届时无法恢复原进程的证据。
      // 只读取系统诊断标签，不采集业务正文、HTTP 凭据或完整设备日志。
      const diagnostics = {
        capturedAt: new Date().toISOString(),
        hostAvailableMemoryBytes: freemem(),
        captures: {},
      };
      for (const [kind, args] of [
        ["appMemory", ["shell", "dumpsys", "meminfo", "site.robotclaw.umaagent.debug"]],
        ["frames", ["shell", "dumpsys", "gfxinfo", "site.robotclaw.umaagent.debug"]],
        [
          "systemLog",
          [
            "logcat",
            "-d",
            "-t",
            "500",
            "-v",
            "threadtime",
            "AndroidRuntime:E",
            "TestRunner:I",
            "Choreographer:I",
            "OpenGLRenderer:W",
            "*:S",
          ],
        ],
      ]) {
        const capture = spawnSync(adb, ["-s", serial, ...args], {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        diagnostics.captures[kind] = {
          stdout: capture.stdout ?? "",
          stderr: capture.stderr ?? "",
          exitCode: capture.status,
          error: capture.error?.message,
        };
      }
      await writeFile(join(evidenceDir, `${name}.diagnostics.json`), JSON.stringify(diagnostics, null, 2));
    }
    return parsed;
  };
  // 先用同一 APK 的运行器发现清单，再核对每个方法终态；总数下限防止错装残缺 APK。
  const discovery = await instrument(["notClass", performanceClass], "discovery", undefined, true);
  result.discovery = discovery;
  if (!discovery.passed || discovery.tests < 38) throw new Error("Incomplete Android test discovery");
  // 两个阶段均为硬门禁，性能失败仍使整个命令失败，不能用功能通过覆盖它。
  result.environment.hostAvailableMemoryBeforeTestsBytes = freemem();
  // 反射注入、renderer 终止和 Activity/IME 窗口状态不得污染后续用例。
  // 每个方法由真实运行器启动新进程，方法内仍运行完整业务闭环；清单合并不允许漏跑。
  result.executionIsolation = "method";
  const methodResults = [];
  for (const identity of discovery.identities) {
    methodResults.push(
      await instrument(["class", identity], `functional-${identity.split(".").at(-1)}`, [identity]),
    );
  }
  const functional = mergeInstrumentation(methodResults, discovery.identities);
  result.functional = functional;
  const recoveryId = "site.robotclaw.umaagent.ProcessRecoverySeedTest#seedAcknowledgedConversationAndDraft";
  result.recoverySeed = await instrument(["class", recoveryId], "recovery-seed", [recoveryId]);
  if (!result.recoverySeed.passed) throw new Error("Process recovery seed failed");
  if (server.exitCode !== null || server.signalCode !== null)
    throw new Error("Faux exited before the intentional offline recovery check");
  // 真正结束进程并撤掉网络依赖；校验分支还会核对 PID 不同，禁止同进程冒充恢复。
  device("shell", "am", "force-stop", "site.robotclaw.umaagent.debug");
  await stopServer();
  result.offlineServerExit = { code: server.exitCode, signal: server.signalCode };
  result.recovery = await instrument(["class", recoveryId], "recovery-verify", [recoveryId], false, [
    "-e",
    "recoveryStage",
    "verify",
  ]);
  // 本轮没有生成性能样本时，不得读取上一轮残留值。
  device("shell", "run-as", "site.robotclaw.umaagent.debug", "rm", "-f", "cache/uma-performance.json");
  const performance = await instrument(["class", performanceClass], "performance", [
    `${performanceClass}#controlledStreamingLatencyAndFrames`,
  ]);
  result.performance = performance;
  let samples;
  try {
    samples = JSON.parse(
      device("exec-out", "run-as", "site.robotclaw.umaagent.debug", "cat", "cache/uma-performance.json"),
    );
  } catch {
    performance.passed = false;
  }
  result.samples = samples;
  result.passed =
    functional.passed &&
    functional.tests >= 38 &&
    result.recovery.passed &&
    performance.passed &&
    performance.tests === 1;
} catch (error) {
  result.error = String(error);
} finally {
  // 清理异常也必须落盘；不能遮蔽原始失败，不能报告成功却留下服务或设备设置。
  try {
    await stopServer();
  } catch (error) {
    server?.kill("SIGKILL");
    result.cleanupErrors.push(String(error));
  }
  if (serverLog) await new Promise((done) => serverLog.end(done));
  try {
    if (previousIme === "null")
      device("shell", "settings", "delete", "secure", "show_ime_with_hard_keyboard");
    else if (previousIme !== undefined)
      device("shell", "settings", "put", "secure", "show_ime_with_hard_keyboard", previousIme);
    if (previousIme !== undefined) {
      result.deviceSettingsRestored =
        device("shell", "settings", "get", "secure", "show_ime_with_hard_keyboard").trim() === previousIme;
      if (!result.deviceSettingsRestored) result.cleanupErrors.push("Device IME setting was not restored");
    }
  } catch (error) {
    result.cleanupErrors.push(String(error));
  }
  result.passed &&= !result.error && result.cleanupErrors.length === 0;
  if (result.passed) {
    try {
      await rm(stateDir, { recursive: true, force: true });
    } catch (error) {
      result.cleanupErrors.push(String(error));
      result.passed = false;
    }
  }
  result.finishedAt = new Date().toISOString();
  result.environment.hostAvailableMemoryAfterTestsBytes = freemem();
  result.stateDir = result.passed ? null : stateDir;
  await writeFile(join(evidenceDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      passed: result.passed,
      functional: result.functional,
      performance: result.performance,
      recovery: result.recovery,
      p95Ms: result.samples?.p95Ms,
      error: result.error,
      cleanupErrors: result.cleanupErrors,
      evidenceDir,
    }),
  );
  if (!result.passed) console.error(`Android evidence: ${evidenceDir}; isolated state retained: ${stateDir}`);
  process.exitCode = result.passed ? 0 : 1;
}
