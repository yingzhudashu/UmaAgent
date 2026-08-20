import type { KnowledgeSource, SkillSummary } from "@uma-agent/protocol";

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
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            const path = window.prompt("服务器上的知识目录路径")?.trim();
            if (!path) return;
            const name = window.prompt("知识库名称", path.split(/[\\/]/).at(-1) || "Knowledge")?.trim();
            if (name) addKnowledgePath(name, path);
          }}
        >
          添加目录
        </button>
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
