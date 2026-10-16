/**
 * Empryo's existing chat model -> renderer-neutral TSP document nodes.
 * Adapted from Hermes' semantic transcript/tool projection approach (MIT):
 * https://github.com/kvnloo/hermes-agent/tree/ba430cf6cb567122134a6daa61a227a9c33e36c7/ui-tsp/src
 *
 * This module does not initialize a Tern session or replace OpenTUI.
 */
import type { ChatMessage, ToolCall } from "../../types/index.js";

export type NativeKind = "col" | "md" | "text" | "tool";

export interface NativeNode {
  id: string;
  k: NativeKind;
  p?: Record<string, unknown>;
  c?: NativeNode[];
}

const TOOL_ROLES: Record<string, string> = {
  terminal: "bash",
  shell: "bash",
  read_file: "read",
  read_code: "read",
  edit_file: "edit",
  patch: "edit",
  write_file: "write",
  search_files: "grep",
  grep: "grep",
  glob: "glob",
  web_search: "web_search",
  dispatch: "task",
  delegate_task: "task",
  code_execution: "eval",
  ask_user: "ask",
};

function nativeToolName(name: string): string {
  return TOOL_ROLES[name] ?? name;
}

function optionalTarget(args: Record<string, unknown>): string | undefined {
  for (const key of ["command", "path", "file_path", "pattern", "query", "url"]) {
    const candidate = args[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

function textNode(id: string, text: string, role: string, kind: "md" | "text" = "md"): NativeNode {
  return { id, k: kind, p: { text, role } };
}

export function projectTool(call: ToolCall): NativeNode {
  const state = !call.result ? "running" : call.result.success ? "done" : "error";
  const body = call.result?.error ?? call.result?.output;
  return {
    id: `tool.${call.id}`,
    k: "tool",
    p: {
      role: "omp.tool",
      name: nativeToolName(call.name),
      title: call.name,
      status: state,
      target: optionalTarget(call.args),
      collapsible: Boolean(body),
      collapsed: state !== "running" && Boolean(body),
    },
    c: body ? [textNode(`tool.${call.id}.body`, body, "omp.tool.output", "text")] : [],
  };
}

export interface LiveNativeTool {
  id: string;
  toolName: string;
  state: "running" | "done" | "error";
  args?: string;
  progressText?: string;
  result?: string;
  error?: string;
}

/** Live tools use the same IDs as settled tools, so Tern updates instead of duplicating them. */
export function projectLiveTool(call: LiveNativeTool): NativeNode {
  const body = call.error ?? call.result ?? call.progressText;
  return {
    id: `tool.${call.id}`,
    k: "tool",
    p: {
      role: "omp.tool",
      name: nativeToolName(call.toolName),
      title: call.toolName,
      status: call.state,
      target: call.args,
      collapsible: Boolean(body),
      collapsed: call.state !== "running" && Boolean(body),
    },
    c: body ? [textNode(`tool.${call.id}.body`, body, "omp.tool.output", "text")] : [],
  };
}

/** Keep text/reasoning/tool segments in arrival order. Never lose a tool missing from segments. */
export function projectMessage(message: ChatMessage): NativeNode {
  const id = `message.${message.id}`;
  if (message.role === "user") {
    return {
      id,
      k: "col",
      p: { role: "omp.user" },
      c: [textNode(`${id}.text`, message.content, "omp.user")],
    };
  }
  if (message.role === "system") {
    return {
      id,
      k: "col",
      p: { role: "omp.notice" },
      c: [textNode(`${id}.text`, message.content, "omp.notice", "text")],
    };
  }

  const calls = new Map((message.toolCalls ?? []).map((call) => [call.id, call]));
  const seenCalls = new Set<string>();
  const children: NativeNode[] = [];
  if (message.segments?.length) {
    for (const [i, segment] of message.segments.entries()) {
      if (segment.type === "text") {
        children.push(textNode(`${id}.text.${i}`, segment.content, "omp.assistant"));
      } else if (segment.type === "reasoning") {
        children.push(textNode(`${id}.thinking.${segment.id}`, segment.content, "omp.thinking"));
      } else if (segment.type === "tools") {
        for (const callId of segment.toolCallIds) {
          const call = calls.get(callId);
          if (call && !seenCalls.has(callId)) {
            children.push(projectTool(call));
            seenCalls.add(callId);
          }
        }
      } else if (segment.type === "plan") {
        children.push(textNode(`${id}.plan.${i}`, segment.plan.title, "omp.plan"));
      }
    }
  } else if (message.content) {
    children.push(textNode(`${id}.text`, message.content, "omp.assistant"));
  }

  for (const call of message.toolCalls ?? []) {
    if (!seenCalls.has(call.id)) children.push(projectTool(call));
  }
  return { id, k: "col", p: { role: "omp.assistant" }, c: children };
}

export function projectTranscript(messages: readonly ChatMessage[]): NativeNode[] {
  return messages.map(projectMessage);
}
