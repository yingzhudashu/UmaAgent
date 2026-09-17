import { ConfirmDialog } from "./ConfirmDialog.js";
import { useUnsavedForm } from "./UnsavedChanges.js";

/** 名称编辑与取消确认同属此弹窗；成功关闭由服务端写回执驱动。 */
export function RenameSessionDialog({
  title,
  original,
  busy,
  failed,
  change,
  close,
  save,
}: {
  title: string;
  original: string;
  busy: boolean;
  failed: boolean;
  change: (value: string) => void;
  close: () => void;
  save: () => void;
}) {
  const leave = useUnsavedForm(title !== original, close);
  return (
    <ConfirmDialog title="会话名称" busy={busy} cancel={() => leave(close)} confirm={save}>
      <label>
        会话标题
        <input
          value={title}
          onChange={(event) => change(event.target.value)}
          maxLength={120}
          disabled={busy}
        />
      </label>
      {failed && (
        <p role="alert" className="error">
          修改失败，请重试
        </p>
      )}
    </ConfirmDialog>
  );
}
