import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type UmaClient, UmaClientError } from "@uma-agent/client";
import type { Attachment, InteractionMode, SendMessageRequest } from "@uma-agent/protocol";
import { useEffect, useRef, useState } from "react";

type ConversationDraft = {
  text: string;
  attachments: Attachment[];
  mode: InteractionMode;
  pending?: SendMessageRequest;
};
const emptyDraft = (): ConversationDraft => ({ text: "", attachments: [], mode: "agent" });

/** 页面生命周期内按账号、会话隔离草稿、附件和发送回执；不写浏览器持久存储。 */
export function useConversationDrafts(client: UmaClient, selected: string | undefined) {
  const queryClient = useQueryClient();
  const [uploads, setUploads] = useState<Record<string, number>>({});
  // 草稿与未确认的幂等标识属于原会话；异步回执不能清空后来打开的会话。
  const [drafts, setDrafts] = useState<Record<string, ConversationDraft>>({});
  const authGeneration = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 更换客户端身份本身就是清空本地草稿的触发条件。
  useEffect(() => {
    authGeneration.current++;
    setDrafts({});
    setUploads({});
    return () => {
      authGeneration.current++;
    };
  }, [client]);
  const draft = (selected && drafts[selected]) || emptyDraft();
  const prompt = draft.text;
  const attachments = draft.attachments;
  const interactionMode = draft.mode;
  const updateDraft = (change: (current: ConversationDraft) => ConversationDraft) => {
    if (selected)
      setDrafts((current) => ({ ...current, [selected]: change(current[selected] ?? emptyDraft()) }));
  };
  const setPrompt = (text: string) =>
    updateDraft((current) => (current.pending ? current : { ...current, text }));
  const setInteractionMode = (mode: InteractionMode) =>
    updateDraft((current) => (current.pending ? current : { ...current, mode }));
  const setAttachments = (value: Attachment[] | ((items: Attachment[]) => Attachment[])) =>
    updateDraft((current) =>
      current.pending
        ? current
        : { ...current, attachments: typeof value === "function" ? value(current.attachments) : value },
    );
  const sendMessage = useMutation({
    mutationFn: async ({
      sessionId,
      request,
      retry,
      generation,
    }: {
      sessionId: string;
      request: SendMessageRequest;
      retry: boolean;
      generation: number;
    }) => {
      if (retry) {
        let before: number | undefined;
        for (;;) {
          const page = await client.getSessionHistory(sessionId, before);
          if (generation !== authGeneration.current) return;
          if (page.items.some((item) => item.id === request.messageId)) return;
          if (!page.hasMore || page.oldestSequence === before) break;
          before = page.oldestSequence;
        }
      }
      if (generation === authGeneration.current) await client.sendMessage(sessionId, request.text, request);
    },
    onSuccess: (_, { sessionId, generation }) => {
      if (generation !== authGeneration.current) return;
      setDrafts((current) => ({ ...current, [sessionId]: emptyDraft() }));
      void queryClient.invalidateQueries({ queryKey: ["queue", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["snapshot", sessionId] });
    },
    onError: (error, { sessionId, generation }) => {
      if (generation !== authGeneration.current) return;
      // 明确拒绝才允许修正正文；网络/服务端异常保留原 ID，供人工核对后重试。
      if (error instanceof UmaClientError && error.status >= 400 && error.status < 500)
        setDrafts((current) => {
          const { pending: _, ...editable } = current[sessionId] ?? emptyDraft();
          return { ...current, [sessionId]: editable };
        });
    },
  });

  const uploading = Boolean(selected && uploads[selected]);
  const upload = async (file: Blob, name: string) => {
    if (!selected || draft.pending || sendMessage.isPending) return;
    const sessionId = selected;
    const generation = authGeneration.current;
    setUploads((current) => ({ ...current, [sessionId]: (current[sessionId] ?? 0) + 1 }));
    try {
      const attachment = await client.upload(file, name, sessionId);
      if (generation !== authGeneration.current) return;
      setDrafts((current) => {
        const value = current[sessionId] ?? emptyDraft();
        return { ...current, [sessionId]: { ...value, attachments: [...value.attachments, attachment] } };
      });
    } finally {
      if (generation === authGeneration.current)
        setUploads((current) => ({ ...current, [sessionId]: Math.max(0, (current[sessionId] ?? 1) - 1) }));
    }
  };
  const submit = () => {
    if (!selected || sendMessage.isPending || uploading || (!prompt.trim() && !attachments.length)) return;
    const request = draft.pending ?? {
      messageId: crypto.randomUUID(),
      text: prompt.trim() || "请查看附件。",
      mode: interactionMode,
      attachmentIds: attachments.map((item) => item.id),
    };
    updateDraft((current) => ({ ...current, pending: request }));
    sendMessage.mutate({
      sessionId: selected,
      request,
      retry: Boolean(draft.pending),
      generation: authGeneration.current,
    });
  };
  const clear = () => {
    authGeneration.current++;
    setDrafts({});
    setUploads({});
    sendMessage.reset();
  };
  return {
    draft,
    prompt,
    attachments,
    interactionMode,
    setPrompt,
    setInteractionMode,
    setAttachments,
    sendMessage,
    submit,
    upload,
    clear,
    uploading,
    authGeneration,
  };
}
