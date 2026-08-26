import type { KnowledgeSearchHit, KnowledgeSource, SkillPackage } from "@uma-agent/protocol";
import { type FormEvent, useState } from "react";
import { displayStatus } from "../statusLabels.js";

export function ResourceArea({
  admin,
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
  admin: boolean;
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
    <div className="settings-panel settings-panel--nested">
      {admin && (
        <section className="settings-subsection">
          <div className="settings-subsection__heading">
            <div>
              <h4>技能与 MCP</h4>
              <p>管理已发现的技能包和当前工具连接。</p>
            </div>
            <button type="button" disabled={disabled} onClick={refreshSkills}>
              刷新
            </button>
          </div>
          <form
            className="settings-form settings-form--compact"
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
          {packages.length > 0 && (
            <div className="settings-list settings-list--stacked">
              {packages.map((pkg) => (
                <article key={pkg.id} className="settings-record">
                  <div className="settings-record__heading">
                    <strong>
                      {pkg.name}@{pkg.version}
                    </strong>
                    <small>
                      {displayStatus(pkg.status)} · 风险：
                      {pkg.risk === "high" ? "高" : pkg.risk === "medium" ? "中" : "低"}
                    </small>
                  </div>
                  {pkg.diagnostics.map((item) => (
                    <p className="settings-record__content" key={item}>
                      {item}
                    </p>
                  ))}
                  <div className="settings-record__actions">
                    {pkg.status !== "rejected" && (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => setSkillStatus(pkg.id, "reject")}
                      >
                        拒绝
                      </button>
                    )}
                    {pkg.status === "enabled" ? (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => setSkillStatus(pkg.id, "disable")}
                      >
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
                </article>
              ))}
            </div>
          )}
          {packages.length === 0 && <p className="settings-empty">暂无待管理的技能包。</p>}
          <div className="settings-connection-list">
            {mcp.length === 0 ? (
              <span>暂无 MCP 连接。</span>
            ) : (
              mcp.map((item) => (
                <div key={item.name} className="settings-row">
                  <span>{item.name}</span>
                  <strong className={item.connected ? "settings-state settings-state--ok" : "settings-state"}>
                    {item.connected ? "已连接" : "未连接"}
                  </strong>
                </div>
              ))
            )}
          </div>
        </section>
      )}
      <section className="settings-subsection">
        <div className="settings-subsection__heading">
          <div>
            <h4>知识库</h4>
            <p>添加、索引和检索当前账号可用的知识源。</p>
          </div>
        </div>
        <div className="settings-list settings-list--stacked">
          {knowledge.map((item) => (
            <article key={item.id} className="settings-record">
              <div className="settings-record__heading">
                <strong>{item.name}</strong>
                <small>
                  {item.documentCount} 个文档 · {displayStatus(item.status)}
                </small>
              </div>
              {item.error && <small className="error">{item.error}</small>}
              <div className="settings-record__actions">
                <button type="button" disabled={disabled} onClick={() => reindexKnowledge(item.id)}>
                  重建索引
                </button>
                <button type="button" disabled={disabled} onClick={() => deleteKnowledge(item.id)}>
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
        {knowledge.length === 0 && <p className="settings-empty">暂无知识源。</p>}
        <div className="settings-actions">
          <button type="button" disabled={disabled} onClick={() => setShowPathForm(true)}>
            添加目录
          </button>
          <label className="settings-upload">
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
        {showPathForm && (
          <form className="settings-form settings-form--compact" onSubmit={submitPath}>
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
        <form
          className="settings-form settings-form--compact"
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
        {knowledgeHits.length > 0 && (
          <div className="settings-list settings-list--stacked">
            {knowledgeHits.map((hit, index) => (
              <article key={`${hit.sourceId}:${hit.filePath}:${index}`} className="settings-record">
                <div className="settings-record__heading">
                  <strong>{hit.sourceName}</strong>
                  <small>{hit.filePath}</small>
                </div>
                <p className="settings-record__content">{hit.content}</p>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
