import type { Attachment, InteractionMode } from "@uma-agent/protocol";
import { CircleStop, FilePlus2, Send } from "lucide-react";
import { type RefObject, useRef } from "react";
import { ModeSelector } from "./ModeSelector.js";

export function ConversationComposer({
  attachments,
  removeAttachment,
  interactionMode,
  changeMode,
  prompt,
  changePrompt,
  promptRef,
  disabled,
  hasSession,
  readOnly = false,
  busy,
  submit,
  cancel,
  upload,
}: {
  attachments: Attachment[];
  removeAttachment: (id: string) => void;
  interactionMode: InteractionMode;
  changeMode: (mode: InteractionMode) => void;
  prompt: string;
  changePrompt: (text: string) => void;
  promptRef: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
  hasSession: boolean;
  readOnly?: boolean;
  busy: boolean;
  submit: () => void;
  cancel: () => void;
  upload: (file: File, name: string) => void;
}) {
  const uploadRef = useRef<HTMLInputElement>(null);
  return (
    <>
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((attachment) => (
            <button
              type="button"
              key={attachment.id}
              title={`移除 ${attachment.name}`}
              disabled={disabled || readOnly}
              onClick={() => removeAttachment(attachment.id)}
            >
              {attachment.name} ×
            </button>
          ))}
        </div>
      )}
      <ModeSelector value={interactionMode} onChange={changeMode} disabled={disabled || readOnly} />
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) submit();
        }}
      >
        <button
          type="button"
          className="icon file-button"
          title="上传文件"
          aria-label="上传文件"
          disabled={disabled || readOnly}
          onClick={() => uploadRef.current?.click()}
        >
          <FilePlus2 />
        </button>
        <input
          ref={uploadRef}
          type="file"
          hidden
          disabled={disabled || readOnly}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload(file, file.name);
            event.currentTarget.value = "";
          }}
        />
        <textarea
          ref={promptRef}
          aria-label="消息内容"
          maxLength={20_000}
          rows={1}
          value={prompt}
          readOnly={readOnly}
          onChange={(event) => changePrompt(event.target.value)}
          onPaste={(event) => {
            const image = [...event.clipboardData.items]
              .find((item) => item.kind === "file" && item.type.startsWith("image/"))
              ?.getAsFile();
            if (!image || readOnly || disabled) return;
            event.preventDefault();
            upload(image, `pasted-image-${Date.now()}.${image.type.split("/")[1] ?? "png"}`);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={hasSession ? "向 UmaAgent 发送消息" : "先创建会话"}
          disabled={disabled}
        />
        {busy ? (
          <button
            type="button"
            className="danger icon"
            onClick={cancel}
            disabled={disabled}
            title="停止"
            aria-label="停止"
          >
            <CircleStop />
          </button>
        ) : (
          <button
            type="submit"
            className="primary icon"
            disabled={(!prompt.trim() && attachments.length === 0) || disabled}
            title={readOnly ? "核对并重试发送" : "发送"}
            aria-label={readOnly ? "核对并重试发送" : "发送"}
          >
            <Send />
          </button>
        )}
      </form>
    </>
  );
}
