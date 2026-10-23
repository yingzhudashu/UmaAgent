"""隔离 debug 包的模拟器矩阵；保留设备证据并恢复原尺寸、密度、字体与旋转。"""
from pathlib import Path
import json, os, struct, subprocess, sys, time

ROOT = Path(__file__).resolve().parent.parent
ADB = Path(os.environ["LOCALAPPDATA"]) / "Android/Sdk/platform-tools/adb.exe"

if "--help" in sys.argv:
    print("用法：UMA_ANDROID_DEVICE=<serial> python scripts/android-device-matrix.py [phone ...]")
    print("未设置 UMA_ANDROID_DEVICE 时，要求 adb 恰好连接一台设备。")
    raise SystemExit(0)

def connected_devices():
    if not ADB.exists():
        raise SystemExit(f"adb 不存在：{ADB}")
    output = subprocess.check_output([str(ADB), "devices"], text=True, encoding="utf-8", errors="replace")
    return [line.split("\t", 1)[0] for line in output.splitlines() if "\tdevice" in line]

SERIAL = os.environ.get("UMA_ANDROID_DEVICE", "").strip()
if not SERIAL:
    devices = connected_devices()
    if len(devices) != 1:
        raise SystemExit(f"请设置 UMA_ANDROID_DEVICE；当前可用设备数为 {len(devices)}：{devices}")
    SERIAL = devices[0]
if not SERIAL.startswith("emulator-") or SERIAL not in connected_devices():
    raise SystemExit("设备矩阵只允许已连接的专用模拟器，不修改真实用户设备。")

OUT = ROOT / "artifacts/acceptance" / ("android-matrix-" + time.strftime("%Y%m%d-%H%M%S"))
OUT.mkdir(parents=True, exist_ok=True)
print(f"设备 {SERIAL}；证据 {OUT}", flush=True)

def adb(*args, binary=False):
    return subprocess.check_output([str(ADB), "-s", SERIAL, *args], text=not binary, encoding=None if binary else "utf-8", errors=None if binary else "replace", timeout=60)

def shell(*args):
    return adb("shell", *args).strip()

original = {"size": shell("wm", "size"), "density": shell("wm", "density"),
            "font": shell("settings", "get", "system", "font_scale"),
            "rotation": shell("settings", "get", "system", "user_rotation"),
            "auto": shell("settings", "get", "system", "accelerometer_rotation"),
            "fixedRotation": shell("wm", "fixed-to-user-rotation"),
            "imeWithHardware": shell("settings", "get", "secure", "show_ime_with_hard_keyboard")}
(OUT / "device-original.json").write_text(json.dumps(original, indent=2), encoding="utf-8")
environment = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
               "host": json.loads(subprocess.check_output(["node", "-e", "const os=require('node:os');console.log(JSON.stringify({freeMemoryBytes:os.freemem(),totalMemoryBytes:os.totalmem()}))"], text=True)),
               "deviceMemory": shell("cat", "/proc/meminfo"),
               "deviceCpus": shell("cat", "/sys/devices/system/cpu/present"),
               "fingerprint": shell("getprop", "ro.build.fingerprint"),
               "webview": shell("dumpsys", "webviewupdate")}
(OUT / "environment.json").write_text(json.dumps(environment, indent=2), encoding="utf-8")
matrix = [("phone", "780x1688", "320", "1.0", "0"),
          ("phone200", "780x1688", "320", "2.0", "0"),
          ("narrow", "640x1280", "320", "1.0", "0"),
          ("tablet600", "1200x1920", "320", "1.0", "0"),
          ("dual840", "1680x1800", "320", "1.0", "0"),
          ("landscape200", "780x1688", "320", "2.0", "1")]
results = []
cleanup_errors = []
if len(sys.argv) > 1:
    requested = set(sys.argv[1:])
    if requested - {item[0] for item in matrix}:
        raise SystemExit("未知矩阵配置")
    matrix = [item for item in matrix if item[0] in requested]

def collect(target):
    files = []
    for file in shell("run-as", "site.robotclaw.umaagent.debug", "ls", "cache").splitlines():
        if file.startswith("uma-") and Path(file).suffix in (".png", ".json", ".txt"):
            data = adb("exec-out", "run-as", "site.robotclaw.umaagent.debug", "cat", "cache/" + file, binary=True)
            (target / file).write_bytes(data)
            files.append((file, data))
            try:
                shell("run-as", "site.robotclaw.umaagent.debug", "rm", "cache/" + file)
            except (subprocess.SubprocessError, OSError) as error:
                cleanup_errors.append({"operation": "collect", "file": file, "error": str(error)})
    return files

# 先归档上次测试遗留的证据，避免误归入本轮第一组。
(OUT / "preexisting").mkdir()
collect(OUT / "preexisting")
try:
    # 真实键盘用例需要可见 IME；AVD 接入硬件键盘时不能继承隐藏软键盘的宿主默认值。
    shell("settings", "put", "secure", "show_ime_with_hard_keyboard", "1")
    for name, size, density, font, rotation in matrix:
        target = OUT / name
        target.mkdir(exist_ok=True)
        shell("wm", "size", size)
        shell("wm", "density", density)
        shell("settings", "put", "system", "font_scale", font)
        shell("settings", "put", "system", "accelerometer_rotation", "0")
        shell("settings", "put", "system", "user_rotation", rotation)
        shell("wm", "fixed-to-user-rotation", "enabled")
        shell("wm", "user-rotation", "lock", rotation)
        time.sleep(2)
        # 六组均复用完整入口：同一 APK 清单、全部功能、强停离线恢复及独立性能阶段。
        # 每次独立 Faux 数据和进程，避免上一组会话污染下一组。
        execution = subprocess.run(["node", str(ROOT / "scripts/android-e2e.mjs")], cwd=ROOT,
                                   env={**os.environ, "UMA_ANDROID_DEVICE": SERIAL},
                                   capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1200)
        (target / "stdout.log").write_text(execution.stdout, encoding="utf-8")
        (target / "stderr.log").write_text(execution.stderr, encoding="utf-8")
        summary = next((json.loads(line) for line in reversed(execution.stdout.splitlines())
                        if line.startswith('{"passed":') and '"evidenceDir":' in line), None)
        if summary is None:
            raise RuntimeError("完整 Android 入口未返回验收记录：" + name)
        outcomes = json.loads((Path(summary["evidenceDir"]) / "result.json").read_text(encoding="utf-8"))
        files = collect(target)
        # 设备/截图进程崩溃可能留下空 PNG；保留原件并明确判失败，不中断后续组的证据收集。
        dimensions = {}
        invalid_images = []
        for file, data in files:
            if not file.endswith(".png"):
                continue
            if len(data) < 24 or data[:8] != bytes([137, 80, 78, 71, 13, 10, 26, 10]):
                invalid_images.append(file)
            else:
                dimensions[file] = struct.unpack(">II", data[16:24])
        orientation_ok = bool(dimensions) and not invalid_images and all((width > height) == (rotation == "1") for width, height in dimensions.values())
        (target / "screenshot-dimensions.json").write_text(json.dumps(dimensions, indent=2), encoding="utf-8")
        (target / "display.txt").write_text(shell("dumpsys", "window", "displays"), encoding="utf-8")
        (target / "memory.txt").write_text(shell("dumpsys", "meminfo", "site.robotclaw.umaagent.debug"), encoding="utf-8")
        (target / "frames.txt").write_text(shell("dumpsys", "gfxinfo", "site.robotclaw.umaagent.debug", "framestats"), encoding="utf-8")
        results.append({"configuration": name, "size": size, "density": density, "fontScale": font, "rotation": rotation, "orientationVerified": orientation_ok, "invalidImages": invalid_images, "evidenceDir": summary["evidenceDir"], "outcomes": outcomes, "passed": orientation_ok and outcomes["passed"] and execution.returncode == 0 and not cleanup_errors})
        (OUT / "result.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"configuration": name, "passed": results[-1]["passed"],
                          "functional": outcomes.get("functional", {}).get("passed"),
                          "recovery": outcomes.get("recovery", {}).get("passed"),
                          "p95Ms": outcomes.get("samples", {}).get("p95Ms"),
                          "evidenceDir": summary["evidenceDir"]}), flush=True)
finally:
    # 每项独立恢复；即使设备断开，也记录全部未恢复项和证据路径，不掩盖先前测试失败。
    def restore(*args):
        try:
            shell(*args)
        except (subprocess.SubprocessError, OSError) as error:
            cleanup_errors.append({"command": list(args), "error": str(error)})
    value = original["imeWithHardware"]
    restore("settings", "delete", "secure", "show_ime_with_hard_keyboard") if value == "null" else restore("settings", "put", "secure", "show_ime_with_hard_keyboard", value)
    restore("wm", "fixed-to-user-rotation", original["fixedRotation"])
    for key in ("size", "density"):
        value = original[key].split("Override " + key + ": ")[-1] if "Override " in original[key] else "reset"
        restore("wm", key, value.strip())
    for key, field in (("font", "font_scale"), ("rotation", "user_rotation"), ("auto", "accelerometer_rotation")):
        value = original[key]
        restore("settings", "delete", "system", field) if value == "null" else restore("settings", "put", "system", field, value)
    (OUT / "cleanup.json").write_text(json.dumps({"errors": cleanup_errors}, indent=2), encoding="utf-8")
    print("设备矩阵证据：" + str(OUT), flush=True)
raise SystemExit(0 if all(item["passed"] for item in results) and len(results) == len(matrix) and not cleanup_errors else 1)
