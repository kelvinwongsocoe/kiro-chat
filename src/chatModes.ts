import { ContentBlock } from "./kiroSession";

export type ChatModeId = "default" | "spec" | "quick-spec" | "bug-fix" | "plan";

export interface ChatMode {
  id: ChatModeId;
  label: string;
  description: string;
  instruction?: string;
  readOnly?: boolean;
}

export const CHAT_MODES: readonly ChatMode[] = [
  {
    id: "default",
    label: "Default",
    description: "General coding assistance",
  },
  {
    id: "spec",
    label: "Spec",
    description: "Structured feature development",
    instruction:
      "Work in Spec mode. Develop the feature in explicit phases: clarify the intent, " +
      "capture requirements, propose a design, break the work into tasks, and then implement " +
      "the requested work while keeping those phases visible.",
  },
  {
    id: "quick-spec",
    label: "Quick Spec",
    description: "Clarify, then generate requirements, design, and tasks",
    instruction:
      "Work in Quick Spec mode. Clarify only genuine blockers, then produce concise " +
      "requirements, design, and tasks before proceeding with the requested implementation.",
  },
  {
    id: "bug-fix",
    label: "Bug Fix",
    description: "Investigate, diagnose, and resolve bugs",
    instruction:
      "Work in Bug Fix mode. Investigate or reproduce the problem, identify the root cause, " +
      "apply the smallest safe fix, run focused verification, and report the cause and fix.",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Plan the implementation without making changes",
    instruction:
      "Work in Plan mode. Analyze the request and produce a concrete implementation plan. " +
      "Do not modify files or perform any action that changes the workspace.",
    readOnly: true,
  },
] as const;

export function chatMode(value: unknown): ChatMode {
  return CHAT_MODES.find((mode) => mode.id === value) ?? CHAT_MODES[0];
}

/** Add the selected workflow as an explicit instruction without changing the visible message. */
export function applyChatMode(
  blocks: ContentBlock[],
  mode: ChatMode
): ContentBlock[] {
  if (!mode.instruction) return blocks;
  return [
    {
      type: "text",
      text: `[Kiro Chat mode: ${mode.label}]\n${mode.instruction}\n\nThe user's request follows.`,
    },
    ...blocks,
  ];
}
