import type { KnowledgeSource, SkillSummary } from "@uma-agent/protocol";
import { type FormEvent, useState } from "react";

export function ResourceArea({
  skills,
  mcp,
  knowledge,
  disabled,
  refreshSkills,
  addKnowledgePath,
  uploadKnowledge,
  deleteKnowledge,
}: {
  skills: SkillSummary[];
  mcp: Array<{ name: string; connected: boolean }>;
  knowledge: KnowledgeSource[];
  disabled: boolean;
  refreshSkills: () => void;
  addKnowledgePath: (name: string, path: string) => void;
  uploadKnowledge: (file: File) => void;
  deleteKnowledge: (id: string) => void;
}) {
  const [showPathForm, setShowPathForm] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const submitPath = (event: FormEvent) => {
    event.preventDefault();
    addKnowledgePath(name.trim(), path.trim());
    setShowPathForm(false);
    setName("");
    setPath("");
  };
  return (
    <div className="operation-list">
      <div>
        <strong>Skills</strong>
        <p>{skills.map((item) => item.name).join(", ") || "-"}</p>
        <button type="button" disabled={disabled} onClick={refreshSkills}>
          刷新
        </button>
      </div>
      <div>
        <strong>MCP</strong>
        <p>{mcp.map((item) => `${item.name}:${item.connected ? "online" : "offline"}`).join(", ") || "-"}</p>
      </div>
      <div>
        <strong>Knowledge</strong>
        {knowledge.map((item) => (
          <div key={item.id}>
            <p>
              {item.name} ({item.documentCount}) · {item.status}
            </p>
            {item.error && <small className="error">{item.error}</small>}
            <button type="button" disabled={disabled} onClick={() => deleteKnowledge(item.id)}>
              删除
            </button>
          </div>
        ))}
        <button type="button" disabled={disabled} onClick={() => setShowPathForm(true)}>
          添加目录
        </button>
        {showPathForm && (
          <form className="resource-form" onSubmit={submitPath}>
            <label>
              名称
              <input required value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              服务器工作区路径
              <input required value={path} onChange={(event) => setPath(event.target.value)} />
            </label>
            <div className="approval-actions">
              <button type="button" onClick={() => setShowPathForm(false)}>
                取消
              </button>
              <button type="submit" className="primary" disabled={disabled}>
                导入
              </button>
            </div>
          </form>
        )}
        <label className="run-action">
          上传知识文件
          <input
            type="file"
            hidden
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) uploadKnowledge(file);
            }}
          />
        </label>
      </div>
    </div>
  );
}
