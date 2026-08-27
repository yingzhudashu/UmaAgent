import type { UmaClient } from "@uma-agent/client";
import { UmaClientError } from "@uma-agent/client";
import { KeyRound, Pause, Play, RefreshCw, Search, Send, Square, Store, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type Conversation = { sessionId: string; conversation: Record<string, unknown> };

function readable(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function XianyuArea({ client, onClose }: { client: UmaClient; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [grant, setGrant] = useState<string>();
  const [expiresAt, setExpiresAt] = useState<number>();
  const [status, setStatus] = useState<Record<string, unknown>>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState("");
  const [history, setHistory] = useState<unknown>();
  const [itemId, setItemId] = useState("");
  const [item, setItem] = useState<unknown>();
  const [receiverId, setReceiverId] = useState("");
  const [chatItemId, setChatItemId] = useState("");
  const [description, setDescription] = useState("");
  const [imagePaths, setImagePaths] = useState("");
  const [delivery, setDelivery] = useState("free_shipping");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const clearGrant = useCallback(() => {
    setGrant(undefined);
    setExpiresAt(undefined);
    setStatus(undefined);
    setConversations([]);
    setHistory(undefined);
    setItem(undefined);
  }, []);

  useEffect(() => {
    if (!expiresAt) return;
    const timeout = window.setTimeout(clearGrant, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [expiresAt, clearGrant]);

  const run = async (operation: () => Promise<void>) => {
    try {
      setLoading(true);
      setError(undefined);
      setNotice(undefined);
      await operation();
    } catch (value) {
      if (value instanceof UmaClientError && (value.status === 401 || value.status === 403)) {
        clearGrant();
        setError("咸鱼授权已失效，请重新解锁。");
      } else setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  };

  const refresh = () =>
    grant &&
    void run(async () => {
      setStatus(await client.xianyuStatus(grant));
      setConversations(await client.xianyuConversations<Conversation[]>(grant));
    });

  const unlock = () =>
    void run(async () => {
      const result = await client.xianyuUnlock(password);
      setGrant(result.grant);
      setExpiresAt(result.expiresAt);
      setPassword("");
      setStatus(await client.xianyuStatus(result.grant));
      setConversations(await client.xianyuConversations<Conversation[]>(result.grant));
    });

  const action = (name: "start" | "stop" | "pause" | "resume") =>
    grant &&
    void run(async () => {
      if (name === "start") await client.xianyuStart(grant);
      else if (name === "stop") await client.xianyuStop(grant);
      else if (name === "pause") await client.xianyuPause(grant);
      else await client.xianyuResume(grant);
      setStatus(await client.xianyuStatus(grant));
      setNotice("操作成功");
    });

  const loadHistory = () =>
    grant &&
    selectedConversation &&
    void run(async () => setHistory(await client.xianyuHistory(grant, selectedConversation)));

  const loadItem = () =>
    grant && itemId.trim() && void run(async () => setItem(await client.xianyuItem(grant, itemId.trim())));

  const createChat = () =>
    grant &&
    void run(async () => {
      if (!receiverId.trim() || !chatItemId.trim()) throw new Error("请输入买家 ID 和商品 ID");
      await client.xianyuChat(grant, { receiverId: receiverId.trim(), itemId: chatItemId.trim() });
      setNotice("会话已创建");
      setConversations(await client.xianyuConversations<Conversation[]>(grant));
    });

  const publish = () =>
    grant &&
    void run(async () => {
      if (!description.trim() || !imagePaths.trim()) throw new Error("请输入商品描述和图片路径");
      await client.xianyuPublish(grant, {
        description: description.trim(),
        imagePaths: imagePaths
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        delivery,
      });
      setNotice("商品已发布");
    });

  return (
    <aside className="inspector-drawer" aria-label="咸鱼控制台">
      <header className="inspector-header">
        <h2>
          <Store size={16} /> 咸鱼
        </h2>
        <button type="button" className="icon" onClick={onClose} title="关闭">
          <X size={16} />
        </button>
      </header>
      <div className="inspector-content">
        {!grant ? (
          <div className="inspector-group">
            <p>需要独立管理员密码解锁。</p>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="管理员密码"
            />
            <button type="button" className="run-action" onClick={unlock} disabled={!password || loading}>
              <KeyRound size={15} /> {loading ? "解锁中" : "解锁"}
            </button>
          </div>
        ) : (
          <>
            <div className="inspector-group">
              <p>状态：{String(status?.status ?? "unknown")}</p>
              <p>连接：{status?.connected ? "正常" : "断开"}</p>
              <p>Grant：{expiresAt ? new Date(expiresAt).toLocaleTimeString() : "未知"} 过期</p>
              <div className="button-row">
                <button
                  type="button"
                  className="icon"
                  onClick={() => action("start")}
                  disabled={loading}
                  title="启动"
                >
                  <Play size={15} />
                </button>
                <button
                  type="button"
                  className="icon"
                  onClick={() => action("pause")}
                  disabled={loading}
                  title="暂停"
                >
                  <Pause size={15} />
                </button>
                <button
                  type="button"
                  className="icon"
                  onClick={() => action("resume")}
                  disabled={loading}
                  title="恢复"
                >
                  <Play size={15} />
                </button>
                <button
                  type="button"
                  className="icon"
                  onClick={() => action("stop")}
                  disabled={loading}
                  title="停止"
                >
                  <Square size={15} />
                </button>
                <button type="button" className="icon" onClick={refresh} disabled={loading} title="刷新">
                  <RefreshCw size={15} />
                </button>
              </div>
            </div>
            <div className="inspector-group">
              <h3>会话</h3>
              <select
                value={selectedConversation}
                onChange={(event) => setSelectedConversation(event.target.value)}
              >
                <option value="">选择会话</option>
                {conversations.map((entry) => {
                  const id = String(entry.conversation?.conversationId ?? entry.sessionId);
                  return (
                    <option key={entry.sessionId} value={id}>
                      {entry.sessionId}
                    </option>
                  );
                })}
              </select>
              <button
                type="button"
                className="run-action"
                onClick={loadHistory}
                disabled={!selectedConversation || loading}
              >
                <Search size={15} /> 查看历史
              </button>
              {history !== undefined && <pre>{readable(history)}</pre>}
            </div>
            <div className="inspector-group">
              <h3>商品详情</h3>
              <input
                value={itemId}
                onChange={(event) => setItemId(event.target.value)}
                placeholder="商品 ID"
              />
              <button
                type="button"
                className="run-action"
                onClick={loadItem}
                disabled={!itemId.trim() || loading}
              >
                <Search size={15} /> 查询商品
              </button>
              {item !== undefined && <pre>{readable(item)}</pre>}
            </div>
            <div className="inspector-group">
              <h3>建聊</h3>
              <input
                value={receiverId}
                onChange={(event) => setReceiverId(event.target.value)}
                placeholder="买家 ID"
              />
              <input
                value={chatItemId}
                onChange={(event) => setChatItemId(event.target.value)}
                placeholder="商品 ID"
              />
              <button type="button" className="run-action" onClick={createChat} disabled={loading}>
                <Send size={15} /> 建立会话
              </button>
            </div>
            <div className="inspector-group">
              <h3>发布商品</h3>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="商品描述"
                rows={3}
              />
              <input
                value={imagePaths}
                onChange={(event) => setImagePaths(event.target.value)}
                placeholder="图片路径，逗号分隔"
              />
              <select value={delivery} onChange={(event) => setDelivery(event.target.value)}>
                <option value="free_shipping">包邮</option>
                <option value="distance_based">按距离</option>
                <option value="fixed">固定运费</option>
                <option value="pickup_only">仅自提</option>
              </select>
              <button type="button" className="run-action" onClick={publish} disabled={loading}>
                <Send size={15} /> 发布
              </button>
            </div>
          </>
        )}
        {notice && <p className="action-status">{notice}</p>}
        {error && <p className="error-text">{error}</p>}
      </div>
    </aside>
  );
}
