"""隔离 debug 包的模拟器矩阵；保留设备证据并恢复原尺寸、密度、字体与旋转。"""
from pathlib import Path
import json, os, struct, subprocess, sys, time

ROOT = Path(__file__).resolve().parent.parent
ADB = Path(os.environ["LOCALAPPDATA"]) / "Android/Sdk/platform-tools/adb.exe"
SERIAL = os.environ.get("UMA_ANDROID_DEVICE", "emulator-5556")
OUT = ROOT / "artifacts/acceptance" / ("android-matrix-" + time.strftime("%Y%m%d-%H%M%S"))
OUT.mkdir(parents=True, exist_ok=True)
print(str(OUT), flush=True)

def adb(*args, binary=False):
    return subprocess.check_output([str(ADB), "-s", SERIAL, *args], text=not binary, encoding=None if binary else "utf-8", errors=None if binary else "replace")

def shell(*args):
    return adb("shell", *args).strip()

original = {"size": shell("wm", "size"), "density": shell("wm", "density"),
            "font": shell("settings", "get", "system", "font_scale"),
            "rotation": shell("settings", "get", "system", "user_rotation"),
            "auto": shell("settings", "get", "system", "accelerometer_rotation"),
            "fixedRotation": shell("wm", "fixed-to-user-rotation")}
(OUT / "device-original.json").write_text(json.dumps(original, indent=2), encoding="utf-8")
matrix = [("phone", "780x1688", "320", "1.0", "0"),
          ("phone200", "780x1688", "320", "2.0", "0"),
          ("narrow", "640x1280", "320", "1.0", "0"),
          ("tablet600", "1200x1920", "320", "1.0", "0"),
          ("dual840", "1680x1800", "320", "1.0", "0"),
          ("landscape200", "780x1688", "320", "2.0", "1")]
results = []
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
            shell("run-as", "site.robotclaw.umaagent.debug", "rm", "cache/" + file)
    return files

# 先归档上次测试遗留的证据，避免误归入本轮第一组。
(OUT / "preexisting").mkdir()
collect(OUT / "preexisting")
try:
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
        result = adb("shell", "am", "instrument", "-w", "-r", "-e", "class", ",".join("site.robotclaw.umaagent." + name for name in ("Api35SmokeTest", "ShellLayoutTest", "ConversationLayoutTest", "MessageBodyTest", "BodyPerformanceTest", "OfflineRecoveryTest")), "site.robotclaw.umaagent.debug.test/androidx.test.runner.AndroidJUnitRunner")
        (target / "instrumentation.log").write_text(result, encoding="utf-8")
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
        results.append({"configuration": name, "size": size, "density": density, "fontScale": font, "rotation": rotation, "orientationVerified": orientation_ok, "invalidImages": invalid_images, "passed": orientation_ok and "OK (" in result and "FAILURES" not in result})
        (OUT / "result.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(results[-1]), flush=True)
finally:
    shell("wm", "fixed-to-user-rotation", original["fixedRotation"])
    for key in ("size", "density"):
        value = original[key].split("Override " + key + ": ")[-1] if "Override " in original[key] else "reset"
        shell("wm", key, value.strip())
    for key, field in (("font", "font_scale"), ("rotation", "user_rotation"), ("auto", "accelerometer_rotation")):
        value = original[key]
        shell("settings", "delete", "system", field) if value == "null" else shell("settings", "put", "system", field, value)
raise SystemExit(0 if all(item["passed"] for item in results) and len(results) == len(matrix) else 1)
