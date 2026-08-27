import type { UmaClient } from "@uma-agent/client";
import { KeyRound, Pause, Play, Square, Store, X } from "lucide-react";
import { useState } from "react";

export function XianyuArea({ client, onClose }: { client: UmaClient; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [grant, setGrant] = useState<string>();
  const [status, setStatus] = useState<Record<string, unknown>>();
  const [error, setError] = useState<string>();
  const unlock = async () => {
    try {
      setError(undefined);
      const result = await client.xianyuUnlock(password);
      setGrant(result.grant);
      setPassword("");
      setStatus(await client.xianyuStatus(result.grant));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  const action = async (name: "start" | "stop" | "pause" | "resume") => {
    if (!grant) return;
    try {
      setError(undefined);
      if (name === "start") await client.xianyuStart(grant);
      else if (name === "stop") await client.xianyuStop(grant);
      else if (name === "pause") await client.xianyuPause(grant);
      else await client.xianyuResume(grant);
      setStatus(await client.xianyuStatus(grant));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  return (
    <aside className="inspector-drawer" aria-label="咸鱼控制台">
      <header>
        <h2>
          <Store size={16} /> 咸鱼
        </h2>
        <button type="button" className="icon" onClick={onClose} title="关闭">
          <X size={16} />
        </button>
      </header>
      {!grant ? (
        <div className="inspector-group">
          <p>需要独立管理员密码解锁。</p>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="管理员密码"
          />
          <button type="button" className="run-action" onClick={() => void unlock()} disabled={!password}>
            <KeyRound size={15} /> 解锁
          </button>
        </div>
      ) : (
        <div className="inspector-group">
          <p>状态：{String(status?.status ?? "unknown")}</p>
          <p>连接：{status?.connected ? "正常" : "断开"}</p>
          <div className="button-row">
            <button type="button" className="icon" onClick={() => void action("start")} title="启动">
              <Play size={15} />
            </button>
            <button type="button" className="icon" onClick={() => void action("pause")} title="暂停">
              <Pause size={15} />
            </button>
            <button type="button" className="icon" onClick={() => void action("resume")} title="恢复">
              <Play size={15} />
            </button>
            <button type="button" className="icon" onClick={() => void action("stop")} title="停止">
              <Square size={15} />
            </button>
          </div>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </aside>
  );
}
