/**
 * 剧本环节左栏的对话状态：消息流 + 本轮补充要求 + 忙碌位。
 *
 * 之所以放在 store 而不是组件内的 hook：交互是"左栏写要求、右栏点按钮"，
 * 两个组件要共享同一份对话状态；放在这里也让"跑一次 AI"这件事可被单测。
 */

import { create } from "zustand";
import { describeError } from "../i18n";
import { toApiError } from "../lib/ipc";
import { ACTION_LABELS, type AiAction, type ScriptScope } from "../lib/llmPrompts";
import { newId } from "../lib/scriptOps";
import { describeScope, runScriptAi, type AiRunOutcome } from "./aiScript";
import { useAppStore } from "./store";

export interface ChatMessage {
  id: string;
  role: "user" | "ai";
  /** 用户消息是「作用域 · 动作」，AI 消息固定为「AI」。 */
  title: string;
  body: string;
  state: "streaming" | "done" | "error";
}

/** 把一次运行的结果翻成一句人话回执，让用户知道"为什么这个字段没变"。 */
function receipt(outcome: AiRunOutcome): string {
  const lines: string[] = [
    outcome.applied.length > 0
      ? `已写入：${outcome.applied.join("、")}。`
      : "这次没有可写入的字段。",
  ];
  if (outcome.skipped.length > 0) {
    lines.push(`已锁定、未覆盖：${outcome.skipped.join("、")}。`);
  }
  return lines.join("\n");
}

interface AiChatState {
  messages: ChatMessage[];
  busy: boolean;
  /** 左栏输入框里的补充要求，会拼进下一次请求。 */
  instruction: string;
  setInstruction: (value: string) => void;
  clear: () => void;
  run: (action: AiAction, scope: ScriptScope) => Promise<void>;
}

export const useAiChat = create<AiChatState>()((set, get) => ({
  messages: [],
  busy: false,
  instruction: "",

  setInstruction: (instruction) => set({ instruction }),

  clear: () => set({ messages: [] }),

  run: async (action, scope) => {
    if (get().busy) return;
    const project = useAppStore.getState().project;
    if (!project) return;

    const instruction = get().instruction.trim();
    const aiId = newId("msg");
    const userMessage: ChatMessage = {
      id: newId("msg"),
      role: "user",
      // 这行就是"右栏 → 左栏上下文同步"的可见证据：AI 知道自己在改哪一块。
      title: `${describeScope(scope, project)} · ${ACTION_LABELS[action]}`,
      body: instruction || "（没有补充要求，就按右栏现状来）",
      state: "done",
    };
    const aiMessage: ChatMessage = {
      id: aiId,
      role: "ai",
      title: "AI",
      body: "",
      state: "streaming",
    };
    set((state) => ({ messages: [...state.messages, userMessage, aiMessage], busy: true }));

    const patchAi = (change: Partial<ChatMessage>): void =>
      set((state) => ({
        messages: state.messages.map((message) =>
          message.id === aiId ? { ...message, ...change } : message,
        ),
      }));

    let raw = "";
    try {
      const outcome = await runScriptAi({
        action,
        scope,
        instruction: instruction || undefined,
        onDelta: (delta) => {
          raw += delta;
          set((state) => ({
            messages: state.messages.map((message) =>
              message.id === aiId ? { ...message, body: message.body + delta } : message,
            ),
          }));
        },
      });
      const summary = receipt(outcome);
      patchAi({
        state: "done",
        body: raw.trim() ? `${summary}\n\n── 模型原始返回 ──\n${raw}` : summary,
      });
    } catch (error) {
      patchAi({ state: "error", body: describeError(toApiError(error)) });
    } finally {
      set({ busy: false });
    }
  },
}));
