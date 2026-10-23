/**
 * TSP projection of the actual Empryo runChat event stream. The event contract
 * is src/headless/types.ts, not Hermes' JSON-RPC gateway. Presentation is
 * adapted from Hermes/Nous Research's MIT Tern preview.
 */
import type { HeadlessEvent } from "../../headless/types.js";
import type { ChatMessage, MessageSegment, ToolCall } from "../../types/index.js";
import { type NativeNode, projectTranscript } from "./projection.js";

type AgentState = "running" | "done" | "error";
interface AgentCard {
  key: string;
  title: string;
  state: AgentState;
  target?: string;
  detail?: string;
  error?: string;
}

export class NativeTranscript {
  readonly messages: ChatMessage[] = [];
  readonly queued: string[] = [];
  #active: ChatMessage | null = null;
  #sequence = 0;
  #steps = 0;
  readonly #agentCards = new Map<string, Map<string, AgentCard>>();

  get busy(): boolean {
    return this.#active !== null;
  }

  get steps(): number {
    return this.#steps;
  }

  get activeMessageId(): string | null {
    return this.#active?.id ?? null;
  }

  submit(text: string): void {
    if (this.#active) {
      this.queued.push(text);
      return;
    }
    this.#begin(text);
  }

  notice(message: string): void {
    this.messages.push({
      id: this.#id("notice"),
      role: "system",
      content: message,
      timestamp: Date.now(),
      showInChat: true,
    });
  }

  /** The callback is scoped to its runner/tab before reaching this projection. */
  receive(event: HeadlessEvent): void {
    switch (event.type) {
      case "start":
        return;
      case "ready":
        return;
      case "text":
        this.#text(event.content);
        return;
      case "reasoning":
        this.#reason(event.content);
        return;
      case "tool-call":
        this.#toolCall(event.tool, event.toolCallId, event.input);
        return;
      case "tool-result":
        this.#toolResult(
          event.tool,
          event.toolCallId,
          event.output ?? event.summary,
          event.success !== false,
          event.error,
        );
        return;
      case "subagent-event":
        this.#agentEvent(event.event);
        return;
      case "subagent-step":
        this.#agentStep(event.event);
        return;
      case "subagent-stats":
        this.#agentStats(event.event);
        return;
      case "step":
        this.#steps = event.step;
        return;
      case "turn-done":
        this.#finish(event.output, event.error);
        return;
      case "done":
        this.#finish(event.output, event.error);
        return;
      case "warning":
        this.notice(event.message);
        return;
      case "error":
        this.fail(event.error);
        return;
      case "session-saved":
        return;
      case "chat-done":
        return;
      case "ask-user":
        return;
      case "approval-request":
        return;
      case "plan-review":
        return;
    }
  }

  /** After an interrupted runChat, never attach a new turn to the old one. */
  interrupt(): void {
    if (!this.#active) return;
    this.#active = null;
    this.notice("Turn interrupted.");
    this.#advance();
  }

  /** A failed engine cannot complete this or queued turns: retire both. */
  fail(message: string): void {
    if (this.#active) {
      this.#active.durationMs = Date.now() - this.#active.timestamp;
      for (const call of this.#active.toolCalls ?? []) {
        if (!call.result) call.result = { success: false, output: "", error: message };
      }
      this.#active = null;
    }
    this.queued.length = 0;
    this.notice(message);
  }

  project(): NativeNode[] {
    const nodes = projectTranscript(this.messages);
    for (const [index, message] of this.messages.entries()) {
      const parent = nodes[index];
      if (!parent) continue;
      for (const call of message.toolCalls ?? []) {
        const agents = this.#agentCards.get(call.id);
        if (!agents?.size) continue;
        const tool = parent.c?.find((child) => child.id === "tool." + call.id);
        if (!tool) continue;
        if (!tool.c) tool.c = [];
        for (const card of agents.values()) {
          const detail = [card.error, card.detail].filter(Boolean).join("\n");
          tool.c.push({
            id: "agent." + call.id + "." + card.key,
            k: "tool",
            p: {
              role: "omp.tool",
              name: "task",
              title: card.title,
              target: card.target,
              status: card.state,
              collapsible: Boolean(detail),
              collapsed: card.state !== "running" && Boolean(detail),
            },
            c: detail
              ? [
                  {
                    id: "agent." + call.id + "." + card.key + ".detail",
                    k: "text",
                    p: { role: "omp.tool.output", text: detail },
                  },
                ]
              : [],
          });
        }
      }
    }
    return nodes;
  }

  #cards(parentId: string): Map<string, AgentCard> | null {
    if (!this.messages.some((message) => message.toolCalls?.some((tool) => tool.id === parentId))) {
      return null;
    }
    let cards = this.#agentCards.get(parentId);
    if (!cards) {
      cards = new Map();
      this.#agentCards.set(parentId, cards);
    }
    return cards;
  }

  #agentEvent(event: Extract<HeadlessEvent, { type: "subagent-event" }>["event"]): void {
    const cards = this.#cards(event.parentToolCallId);
    if (!cards) return;
    const key = event.agentId ? "agent." + event.agentId : "dispatch";
    const existing = cards.get(key);
    const state: AgentState =
      event.type === "agent-error" || (event.type === "agent-done" && event.succeeded === false)
        ? "error"
        : event.type === "agent-done" || event.type === "dispatch-done"
          ? "done"
          : "running";
    const detail = [
      event.warning,
      event.modelId ? "Model: " + event.modelId : "",
      event.tier ? "Tier: " + event.tier : "",
      event.completedAgents !== undefined && event.totalAgents !== undefined
        ? "Completed: " + event.completedAgents + "/" + event.totalAgents
        : "",
      event.findingCount !== undefined ? "Findings: " + event.findingCount : "",
      event.resultChars !== undefined ? "Result length: " + event.resultChars + " chars" : "",
      event.toolUses !== undefined ? "Tool uses: " + event.toolUses : "",
    ]
      .filter(Boolean)
      .join(" · ");
    cards.set(key, {
      key,
      title: (event.agentId ?? "Dispatch") + (event.role ? " (" + event.role + ")" : ""),
      state,
      target: event.task ?? existing?.target,
      detail: detail || existing?.detail || event.type,
      error: event.error,
    });
  }

  #agentStep(event: Extract<HeadlessEvent, { type: "subagent-step" }>["event"]): void {
    const cards = this.#cards(event.parentToolCallId);
    if (!cards) return;
    const key = "step." + (event.agentId ?? "dispatch") + "." + event.toolName;
    const previous = cards.get(key);
    cards.set(key, {
      key,
      title: (event.agentId ? event.agentId + ": " : "") + event.toolName,
      target: event.args ?? previous?.target,
      state: event.state,
      detail:
        [
          event.cacheState ? "Cache: " + event.cacheState : "",
          event.sourceAgentId ? "Source: " + event.sourceAgentId : "",
          event.backend ? "Backend: " + event.backend : "",
        ]
          .filter(Boolean)
          .join(" · ") || previous?.detail,
    });
  }

  #agentStats(event: Extract<HeadlessEvent, { type: "subagent-stats" }>["event"]): void {
    const cards = this.#cards(event.parentToolCallId);
    if (!cards) return;
    const key = "agent." + event.agentId;
    const existing = cards.get(key);
    cards.set(key, {
      key,
      title: existing?.title ?? event.agentId,
      state: existing?.state ?? "running",
      target: existing?.target,
      error: existing?.error,
      detail: [
        existing?.detail,
        "Steps: " + event.stepCount,
        "Tools: " + event.toolUses,
        "Tokens: " + event.tokenUsage.total,
        "Cache hits: " + event.cacheHits,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  #id(kind: string): string {
    this.#sequence++;
    return kind + "." + String(this.#sequence);
  }

  #begin(prompt: string): void {
    this.messages.push({
      id: this.#id("user"),
      role: "user",
      content: prompt,
      timestamp: Date.now(),
    });
    const assistant: ChatMessage = {
      id: this.#id("assistant"),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      segments: [],
      toolCalls: [],
    };
    this.messages.push(assistant);
    this.#active = assistant;
    this.#steps = 0;
  }

  #parts(): MessageSegment[] | null {
    const active = this.#active;
    if (!active) return null;
    if (!active.segments) active.segments = [];
    return active.segments;
  }

  #text(content: string): void {
    const parts = this.#parts();
    if (!parts || !content) return;
    const last = parts.at(-1);
    if (last?.type === "text") last.content += content;
    else parts.push({ type: "text", content });
    if (this.#active) this.#active.content += content;
  }

  #reason(content: string): void {
    const parts = this.#parts();
    if (!parts || !content) return;
    const last = parts.at(-1);
    if (last?.type === "reasoning") last.content += content;
    else parts.push({ type: "reasoning", id: this.#id("reasoning"), content });
  }

  #toolCall(name: string, callId: string | undefined, args?: Record<string, unknown>): void {
    const parts = this.#parts();
    const assistant = this.#active;
    if (!parts || !assistant) return;
    const id = callId ?? this.#id("call");
    const known = assistant.toolCalls?.find((item) => item.id === id);
    if (known) return;
    const call: ToolCall = { id, name, args: args ?? {} };
    if (!assistant.toolCalls) assistant.toolCalls = [];
    assistant.toolCalls.push(call);
    const last = parts.at(-1);
    if (last?.type === "tools") last.toolCallIds.push(id);
    else parts.push({ type: "tools", toolCallIds: [id] });
  }

  #toolResult(
    name: string,
    callId: string | undefined,
    output: string,
    success: boolean,
    error?: string,
  ): void {
    const assistant = this.#active;
    if (!assistant) return;
    let call = callId
      ? assistant.toolCalls?.find((item) => item.id === callId)
      : assistant.toolCalls?.findLast((item) => item.name === name && !item.result);
    if (!call) {
      const id = callId ?? this.#id("call");
      this.#toolCall(name, id);
      call = assistant.toolCalls?.find((item) => item.id === id);
    }
    if (call) {
      call.result = {
        success,
        output,
        ...(error ? { error: output ? error + "\n" + output : error } : {}),
      };
    }
  }

  #finish(output: string, error?: string): void {
    if (this.#active) {
      if (output && !this.#active.segments?.some((part) => part.type === "text")) {
        this.#text(output);
      }
      this.#active.durationMs = Date.now() - this.#active.timestamp;
      this.#active = null;
    }
    if (error) this.notice(error);
    this.#advance();
  }

  #advance(): void {
    const next = this.queued.shift();
    if (next) this.#begin(next);
  }
}
