import type { UmaClient } from "@uma-agent/client";
import { Bot, Copy, LogIn } from "lucide-react";
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
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      if (mode === "register") {
        const result = await client.register(label);
        setIssued(result.token);
        setCopied(false);
        return;
      }
      await client.login(token);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : mode === "register" ? "注册失败" : "登录失败");
    }
  };
  const copyIssued = async () => {
    try {
      await navigator.clipboard.writeText(issued);
      setCopied(true);
      setError("");
    } catch {
      setCopied(false);
      setError("复制失败，请手动复制令牌");
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
        {issued ? (
          <>
            <output className="token-result">请立即保存此令牌：{issued}</output>
            <button type="button" className="secondary" onClick={() => void copyIssued()}>
              <Copy size={17} />
              {copied ? "已复制" : "复制令牌"}
            </button>
            <button type="button" className="primary" onClick={onDone}>
              继续进入
            </button>
          </>
        ) : (
          <>
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
            <button className="primary" type="submit">
              <LogIn size={17} />
              {mode === "register" ? "注册" : "登录"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setError("");
                setIssued("");
                setCopied(false);
              }}
            >
              {mode === "login" ? "创建新账户" : "已有令牌，返回登录"}
            </button>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </form>
    </Shell>
  );
}
