import type { KnowledgeSearchHit, KnowledgeSource, SkillPackage } from "@uma-agent/protocol";
import { FolderPlus, RefreshCw, Search, ShieldCheck, Trash2, Upload } from "lucide-react";
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
    <>
      <section className="settings-section settings-section--operation">
        <div className="settings-section-heading">
          <div>
            <h3>知识库</h3>
            <p>添加、索引和检索当前账号可用的知识源。</p>
          </div>
        </div>
        {knowledge.length === 0 ? (
          <p className="settings-empty">暂无知识源。</p>
        ) : (
          <div className="settings-list settings-list--operation">
            {knowledge.map((item) => (
              <article key={item.id} className="settings-record">
                <div className="settings-record__heading">
                  <strong>{item.name}</strong>
                  <small>
                    {item.documentCount} 个文档 · {displayStatus(item.status)}
                  </small>
                </div>
                {item.error && <p className="settings-record__error">{item.error}</p>}
                <div className="settings-record__actions">
                  <button
                    type="button"
                    className="settings-icon-button"
                    title="重建索引"
                    aria-label="重建索引"
                    disabled={disabled}
                    onClick={() => reindexKnowledge(item.id)}
                  >
                    <RefreshCw size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="settings-icon-button"
                    title="删除知识源"
                    aria-label="删除知识源"
                    disabled={disabled}
                    onClick={() => deleteKnowledge(item.id)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        <div className="settings-inline-actions">
          <button
            type="button"
            className="settings-inline-command"
            disabled={disabled}
            onClick={() => setShowPathForm(true)}
          >
            <FolderPlus size={14} aria-hidden="true" /> 添加目录
          </button>
          <label className="settings-inline-command" title="上传知识文件">
            <Upload size={14} aria-hidden="true" /> 上传知识文件
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
            <div className="settings-form-actions">
              <button type="button" onClick={() => setShowPathForm(false)}>
                取消
              </button>
              <button type="submit" className="primary settings-primary" disabled={disabled}>
                导入
              </button>
            </div>
          </form>
        )}
        <form
          className="settings-search"
          onSubmit={(event) => {
            event.preventDefault();
            void searchKnowledge(knowledgeQuery.trim()).then(setKnowledgeHits);
          }}
        >
          <Search size={14} aria-hidden="true" />
          <input
            aria-label="搜索知识库"
            value={knowledgeQuery}
            onChange={(event) => setKnowledgeQuery(event.target.value)}
          />
          <button type="submit" disabled={!knowledgeQuery.trim()}>
            搜索
          </button>
        </form>
        {knowledgeHits.length > 0 && (
          <div className="settings-list settings-list--operation">
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
      {admin && (
        <section className="settings-section settings-section--operation">
          <div className="settings-section-heading">
            <div>
              <h3>技能与 MCP</h3>
              <p>管理已发现的技能包和当前工具连接。</p>
            </div>
            <button
              type="button"
              className="settings-icon-button"
              title="刷新技能"
              aria-label="刷新技能"
              disabled={disabled}
              onClick={refreshSkills}
            >
              <RefreshCw size={14} aria-hidden="true" />
            </button>
          </div>
          <details className="settings-disclosure">
            <summary>
              <FolderPlus size={14} aria-hidden="true" /> 扫描本地技能目录
            </summary>
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
              <div className="settings-form-actions">
                <span className="settings-help">扫描后可在此处启用或拒绝技能。</span>
                <button
                  type="submit"
                  className="primary settings-primary"
                  disabled={disabled || !skillPath.trim()}
                >
                  暂存并扫描
                </button>
              </div>
            </form>
          </details>
          {packages.length === 0 ? (
            <p className="settings-empty">暂无待管理的技能包。</p>
          ) : (
            <div className="settings-list settings-list--operation">
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
                    {pkg.status === "enabled" ? (
                      <button
                        type="button"
                        className="settings-inline-command"
                        disabled={disabled}
                        onClick={() => setSkillStatus(pkg.id, "disable")}
                      >
                        停用
                      </button>
                    ) : pkg.status !== "rejected" ? (
                      <button
                        type="button"
                        className="settings-inline-command"
                        disabled={disabled}
                        onClick={() => setSkillStatus(pkg.id, "enable")}
                      >
                        <ShieldCheck size={14} aria-hidden="true" /> 启用
                      </button>
                    ) : null}
                    {pkg.status !== "rejected" && (
                      <button
                        type="button"
                        className="settings-icon-button"
                        title="拒绝技能"
                        aria-label="拒绝技能"
                        disabled={disabled}
                        onClick={() => setSkillStatus(pkg.id, "reject")}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
          {mcp.length === 0 ? (
            <p className="settings-empty">暂无 MCP 连接。</p>
          ) : (
            <div className="settings-list settings-list--operation">
              {mcp.map((item) => (
                <div key={item.name} className="settings-record settings-connection-row">
                  <span>{item.name}</span>
                  <strong className={item.connected ? "settings-state settings-state--ok" : "settings-state"}>
                    {item.connected ? "已连接" : "未连接"}
                  </strong>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
