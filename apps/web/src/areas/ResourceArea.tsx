import type { KnowledgeSearchHit, KnowledgeSource, SkillPackage, SkillSummary } from "@uma-agent/protocol";
import { type FormEvent, useState } from "react";

export function ResourceArea({
  skills,
  packages,
  mcp,
  knowledge,
  disabled,
  refreshSkills,
  installSkill,
  setSkillStatus,
  addKnowledgePath,
  uploadKnowledge,
  deleteKnowledge,
  reindexKnowledge,
  searchKnowledge,
}: {
  skills: SkillSummary[];
  packages: SkillPackage[];
  mcp: Array<{ name: string; connected: boolean }>;
  knowledge: KnowledgeSource[];
  disabled: boolean;
  refreshSkills: () => void;
  installSkill: (reference: string) => void;
  setSkillStatus: (id: string, action: "enable" | "disable" | "reject") => void;
  addKnowledgePath: (name: string, path: string) => void;
  uploadKnowledge: (file: File) => void;
  deleteKnowledge: (id: string) => void;
  reindexKnowledge: (id: string) => void;
  searchKnowledge: (query: string, sourceId?: string) => Promise<KnowledgeSearchHit[]>;
}) {
  const [showPathForm, setShowPathForm] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [skillPath, setSkillPath] = useState("");
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeHits, setKnowledgeHits] = useState<KnowledgeSearchHit[]>([]);
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
        <form
          className="resource-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!skillPath.trim()) return;
            installSkill(skillPath.trim());
            setSkillPath("");
          }}
        >
          <label>
            本地技能目录
            <input value={skillPath} onChange={(event) => setSkillPath(event.target.value)} />
          </label>
          <button type="submit" disabled={disabled || !skillPath.trim()}>
            暂存并扫描
          </button>
        </form>
        {packages.map((pkg) => (
          <div key={pkg.id} className="action-card">
            <strong>
              {pkg.name}@{pkg.version}
            </strong>
            <small className="operation-meta">
              {pkg.status} · {pkg.risk}
            </small>
            {pkg.diagnostics.map((item) => (
              <p key={item}>{item}</p>
            ))}
            <div className="approval-actions">
              {pkg.status !== "rejected" && (
                <button type="button" disabled={disabled} onClick={() => setSkillStatus(pkg.id, "reject")}>
                  拒绝
                </button>
              )}
              {pkg.status === "enabled" ? (
                <button type="button" disabled={disabled} onClick={() => setSkillStatus(pkg.id, "disable")}>
                  停用
                </button>
              ) : pkg.status !== "rejected" ? (
                <button
                  type="button"
                  className="primary"
                  disabled={disabled}
                  onClick={() => setSkillStatus(pkg.id, "enable")}
                >
                  启用
                </button>
              ) : null}
            </div>
          </div>
        ))}
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
            <button type="button" disabled={disabled} onClick={() => reindexKnowledge(item.id)}>
              重建索引
            </button>
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
        <form
          className="resource-form"
          onSubmit={(event) => {
            event.preventDefault();
            void searchKnowledge(knowledgeQuery.trim()).then(setKnowledgeHits);
          }}
        >
          <label>
            搜索知识库
            <input value={knowledgeQuery} onChange={(event) => setKnowledgeQuery(event.target.value)} />
          </label>
          <button type="submit" disabled={!knowledgeQuery.trim()}>
            搜索
          </button>
        </form>
        {knowledgeHits.map((hit, index) => (
          <div key={`${hit.sourceId}:${hit.filePath}:${index}`} className="action-card">
            <strong>
              {hit.sourceName} · {hit.filePath}
            </strong>
            <p>{hit.content}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
