/**
 * TSP projection of the actual Empryo runChat event stream. The event contract
 * is src/headless/types.ts, not Hermes' JSON-RPC gateway. Presentation is
 * adapted from Hermes/Nous Research's MIT Tern preview.
 */
import type { HeadlessEvent } from "../../headless/types.js";
import type { ChatMessage, MessageSegment, ToolCall } from "../../types/index.js";
import { type NativeNode, projectTranscript } from "./projection.js";

export class NativeTranscript {
  readonly messages: ChatMessage[] = [];
  readonly queued: string[] = [];
  #active: ChatMessage | null = null;
  #sequence = 0;
  #steps = 0;

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
        this.#toolResult(event.tool, event.toolCallId, event.summary);
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
        this.notice(event.error);
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

  project(): NativeNode[] {
    return projectTranscript(this.messages);
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

  #toolResult(name: string, callId: string | undefined, summary: string): void {
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
    if (call) call.result = { success: true, output: summary };
  }

  #finish(output: string, error?: string): void {
    if (this.#active) {
      if (output && !(this.#active.segments?.some((part) => part.type === "text"))) {
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
