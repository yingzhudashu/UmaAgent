import type { MemoryFact } from "@uma-agent/protocol";
import { Check, X } from "lucide-react";

export function MemoryArea({
  facts,
  disabled,
  reject,
  accept,
}: {
  facts: MemoryFact[];
  disabled: boolean;
  reject: (id: string) => void;
  accept: (id: string) => void;
}) {
  return (
    <section className="settings-section settings-section--operation">
      <div className="settings-section-heading">
        <div>
          <h3>记忆</h3>
          <p>审核从当前会话中提取、等待保留的信息。</p>
        </div>
      </div>
      {facts.length === 0 ? (
        <p className="settings-empty">暂无等待审核的记忆。</p>
      ) : (
        <div className="settings-list settings-list--operation">
          {facts.map((fact) => (
            <article className="settings-record" key={fact.id}>
              <div className="settings-record__heading">
                <strong>{fact.key}</strong>
                <small>可信度 {fact.confidence.toFixed(2)}</small>
              </div>
              <p className="settings-record__content">{fact.value}</p>
              <div className="settings-record__actions">
                <button
                  type="button"
                  className="settings-icon-button"
                  title="拒绝记忆"
                  aria-label="拒绝记忆"
                  disabled={disabled}
                  onClick={() => reject(fact.id)}
                >
                  <X size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="settings-inline-command"
                  disabled={disabled}
                  onClick={() => accept(fact.id)}
                >
                  <Check size={14} aria-hidden="true" /> 保留
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
