import type { KnowledgeSearchHit, KnowledgeSource, SkillPackage } from "@uma-agent/protocol";
import { FolderPlus, RefreshCw, Search, ShieldCheck, Trash2, Upload } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { useOperation } from "../components/OperationFeedback.js";
import { useUnsavedForm } from "../components/UnsavedChanges.js";
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
  refreshSkills: () => unknown;
  installSkill: (reference: string) => unknown;
  setSkillStatus: (id: string, action: "enable" | "disable" | "reject") => unknown;
  addKnowledgePath: (name: string, path: string) => unknown;
  uploadKnowledge: (file: File) => unknown;
  deleteKnowledge: (id: string) => unknown;
  reindexKnowledge: (id: string) => unknown;
  searchKnowledge: (query: string, sourceId?: string) => Promise<KnowledgeSearchHit[]>;
}) {
  const operation = useOperation();
  const uploadInput = useRef<HTMLInputElement>(null);
  const [showPathForm, setShowPathForm] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [skillPath, setSkillPath] = useState("");
  const leave = useUnsavedForm(path !== "" || name !== "", () => {
    setPath("");
    setName("");
  });
  useUnsavedForm(skillPath !== "", () => setSkillPath(""));
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeHits, setKnowledgeHits] = useState<KnowledgeSearchHit[]>([]);
  const submitPath = async (event: FormEvent) => {
    event.preventDefault();
    if (!(await operation.execute(() => addKnowledgePath(name.trim(), path.trim())))) return;
    setShowPathForm(false);
    setName("");
    setPath("");
  };
  return (
    <>
      {operation.feedback}
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
                    disabled={operation.busy || disabled}
                    onClick={() => void operation.execute(() => reindexKnowledge(item.id))}
                  >
                    <RefreshCw size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="settings-icon-button"
                    title="删除知识源"
                    aria-label="删除知识源"
                    disabled={operation.busy || disabled}
                    onClick={() =>
                      operation.confirm(
                        "删除知识源？",
                        `删除“${item.name}”的索引记录，不删除原始文件。`,
                        () => deleteKnowledge(item.id),
                      )
                    }
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        <div className="settings-inline-actions">
          {admin && (
            <button
              type="button"
              className="settings-inline-command"
              disabled={operation.busy || disabled}
              onClick={() => setShowPathForm(true)}
            >
              <FolderPlus size={14} aria-hidden="true" /> 添加目录
            </button>
          )}
          <button
            type="button"
            className="settings-inline-command"
            disabled={operation.busy || disabled}
            onClick={() => uploadInput.current?.click()}
          >
            <Upload size={14} aria-hidden="true" /> 上传知识文件
          </button>
          <input
            ref={uploadInput}
            type="file"
            hidden
            disabled={operation.busy || disabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void operation.execute(() => uploadKnowledge(file));
            }}
          />
        </div>
        {showPathForm && (
          <form className="settings-form settings-form--compact" onSubmit={submitPath}>
            <label>
              名称
              <input
                required
                disabled={operation.busy || disabled}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              服务器工作区路径
              <input
                required
                disabled={operation.busy || disabled}
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </label>
            <div className="settings-form-actions">
              <button
                type="button"
                disabled={operation.busy}
                onClick={() => leave(() => setShowPathForm(false))}
              >
                取消
              </button>
              <button
                type="submit"
                className="primary settings-primary"
                disabled={operation.busy || disabled}
              >
                导入
              </button>
            </div>
          </form>
        )}
        <form
          className="settings-search"
          onSubmit={async (event) => {
            event.preventDefault();
            void operation.execute(() => searchKnowledge(knowledgeQuery.trim()).then(setKnowledgeHits));
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
              disabled={operation.busy || disabled}
              onClick={() => void operation.execute(refreshSkills)}
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
              onSubmit={async (event) => {
                event.preventDefault();
                if (!skillPath.trim()) return;
                if (!(await operation.execute(() => installSkill(skillPath.trim())))) return;
                setSkillPath("");
              }}
            >
              <label>
                本地技能目录
                <input
                  disabled={operation.busy || disabled}
                  value={skillPath}
                  onChange={(event) => setSkillPath(event.target.value)}
                />
              </label>
              <div className="settings-form-actions">
                <span className="settings-help">扫描后可在此处启用或拒绝技能。</span>
                <button
                  type="submit"
                  className="primary settings-primary"
                  disabled={operation.busy || disabled || !skillPath.trim()}
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
                        disabled={operation.busy || disabled}
                        onClick={() =>
                          operation.confirm("确认修改技能状态？", pkg.name, () =>
                            setSkillStatus(pkg.id, "disable"),
                          )
                        }
                      >
                        停用
                      </button>
                    ) : pkg.status !== "rejected" ? (
                      <button
                        type="button"
                        className="settings-inline-command"
                        disabled={operation.busy || disabled}
                        onClick={() =>
                          operation.confirm("确认修改技能状态？", pkg.name, () =>
                            setSkillStatus(pkg.id, "enable"),
                          )
                        }
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
                        disabled={operation.busy || disabled}
                        onClick={() =>
                          operation.confirm("确认修改技能状态？", pkg.name, () =>
                            setSkillStatus(pkg.id, "reject"),
                          )
                        }
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
