import type { UmaClient } from "@uma-agent/client";
import { Bot, LogIn } from "lucide-react";
import { type FormEvent, useState } from "react";

export function Login({
  client,
  embedded,
  onDone,
}: {
  client: UmaClient;
  embedded: boolean;
  onDone: () => void;
}) {
  const [token, setToken] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [label, setLabel] = useState("web");
  const [issued, setIssued] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (mode === "register") {
        const result = await client.register(label);
        setIssued(result.token);
        return;
      }
      await client.login(token);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败");
    }
  };
  const Shell = embedded ? "div" : "main";
  return (
    <Shell className="login-shell">
      <form className="login" onSubmit={submit}>
        <div className="brand-mark">
          <Bot size={24} />
        </div>
        <h1>UmaAgent</h1>
        <p>{mode === "register" ? "创建一个隔离的 UmaAgent 账户" : "连接到你的 Agent Core"}</p>
        {mode === "register" ? (
          <label>
            令牌名称
            <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} />
          </label>
        ) : (
          <label>
            访问令牌
            <input type="password" value={token} onChange={(event) => setToken(event.target.value)} />
          </label>
        )}
        {issued && (
          <>
            <output className="token-result">请立即保存此令牌：{issued}</output>
            <button type="button" className="primary" onClick={onDone}>
              继续进入
            </button>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <button className="primary" type="submit">
          <LogIn size={17} />
          {mode === "register" ? "注册并进入" : "登录"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError("");
          }}
        >
          {mode === "login" ? "创建新账户" : "已有令牌，返回登录"}
        </button>
      </form>
    </Shell>
  );
}
