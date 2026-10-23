import { describe, expect, it } from "bun:test";
import type { ActionEvent } from "@stencil-hq/tern";
import { NativeRunner, type RunChat } from "../src/components/tern/native-runner.js";
import { NativeTranscript } from "../src/components/tern/native-transcript.js";
import { nativeView, toTernNode } from "../src/components/tern/native-view.js";
import type { NativeNode } from "../src/components/tern/projection.js";
import type { HeadlessEvent } from "../src/headless/types.js";
import type { AppConfig, InteractiveCallbacks } from "../src/types/index.js";

const TOKENS = { input: 1, output: 2, cacheRead: 0 };

describe("native TSP transcription of real headless events", () => {
  it("keeps streamed reasoning, tools and final Markdown in arrival order", () => {
    const transcript = new NativeTranscript();
    transcript.submit("read file");
    transcript.receive({ type: "reasoning", content: "inspect " });
    transcript.receive({ type: "reasoning", content: "first" });
    transcript.receive({
      type: "tool-call",
      tool: "read_file",
      toolCallId: "read-1",
      input: { path: "src/app.ts" },
    });
    transcript.receive({
      type: "tool-result",
      tool: "read_file",
      toolCallId: "read-1",
      summary: "ok",
    });
    transcript.receive({ type: "text", content: "Found " });
    transcript.receive({ type: "text", content: "it." });
    const nodes = transcript.project();
    expect(nodes[0]?.p?.role).toBe("omp.user");
    expect(nodes[1]?.c?.map((node) => node.k)).toEqual(["md", "tool", "md"]);
    expect(nodes[1]?.c?.[0]?.p?.text).toBe("inspect first");
    expect(nodes[1]?.c?.[1]?.p?.name).toBe("read");
    expect(nodes[1]?.c?.[1]?.p?.status).toBe("done");
    expect(nodes[1]?.c?.[2]?.p?.text).toBe("Found it.");
    transcript.receive({
      type: "turn-done",
      turn: 1,
      output: "Found it.",
      steps: 1,
      tokens: TOKENS,
      toolCalls: ["read_file"],
      filesEdited: [],
      duration: 100,
    });
    expect(transcript.busy).toBe(false);
    expect(transcript.messages[1]?.content).toBe("Found it.");
  });

  it("queues complete next-turn projections without interleaving assistant output", () => {
    const transcript = new NativeTranscript();
    transcript.submit("first");
    const firstActive = transcript.activeMessageId;
    transcript.submit("second");
    expect(transcript.queued).toEqual(["second"]);
    transcript.receive({ type: "text", content: "answer one" });
    transcript.receive({
      type: "turn-done",
      turn: 1,
      output: "answer one",
      steps: 1,
      tokens: TOKENS,
      toolCalls: [],
      filesEdited: [],
      duration: 20,
    });
    expect(transcript.activeMessageId).not.toBe(firstActive);
    transcript.receive({ type: "text", content: "answer two" });
    expect(transcript.messages.map((message) => message.role)).toEqual([
      "user", "assistant", "user", "assistant",
    ]);
    expect(transcript.messages[1]?.content).toBe("answer one");
    expect(transcript.messages[3]?.content).toBe("answer two");
  });

  it("preserves a saved output when the engine never emitted text deltas", () => {
    const transcript = new NativeTranscript();
    transcript.submit("hello");
    transcript.receive({
      type: "turn-done",
      turn: 1,
      output: "fallback",
      steps: 0,
      tokens: TOKENS,
      toolCalls: [],
      filesEdited: [],
      duration: 10,
    });
    expect(transcript.project()[1]?.c?.[0]?.p?.text).toBe("fallback");
  });

  it("retains tool identity even when the result arrives first", () => {
    const transcript = new NativeTranscript();
    transcript.submit("run");
    transcript.receive({ type: "tool-result", tool: "shell", toolCallId: "x", summary: "ok" });
    expect(transcript.project()[1]?.c?.[0]?.id).toBe("tool.x");
    expect(transcript.project()[1]?.c?.[0]?.p?.name).toBe("bash");
  });

  it("drops an interrupted turn without dropping queued prompts", () => {
    const transcript = new NativeTranscript();
    transcript.submit("first");
    transcript.submit("second");
    transcript.interrupt();
    expect(transcript.busy).toBe(true);
    expect(transcript.messages.at(-2)?.role).toBe("user");
    expect(transcript.messages.at(-2)?.content).toBe("second");
  });
});

describe("native Tern SDK renderable projections", () => {
  it("turns semantic nodes into typed SDK nodes with stable keys", () => {
    const native: NativeNode = {
      id: "tool.123",
      k: "tool",
      p: { role: "omp.tool", name: "bash", status: "running" },
      c: [{ id: "output", k: "text", p: { text: "hello" } }],
    };
    const projected = toTernNode(native);
    expect(projected.kind).toBe("tool");
    expect(projected.props.key).toBe("tool.123");
    expect(projected.children[0]?.props.key).toBe("output");
    expect(projected.children[0]?.props.text).toBe("hello");
  });

  it("wires native overlay actions and edit/send handlers to the SDK", async () => {
    let approved = 0;
    let edited = 0;
    let sent = 0;
    const view = nativeView(
      {
        messages: [],
        model: "provider/model",
        tabs: [{ id: "a", label: "TAB-1" }],
        activeId: "a",
        busy: false,
        steps: 0,
        queued: 0,
        draft: "hello",
        cursor: 5,
        modal: {
          id: "prompt-1",
          title: "Approve?",
          description: "An operation needs approval.",
          choices: [{ id: "allow", label: "Allow once", tone: "accent", activate: () => approved++ }],
        },
      },
      {
        switchTab: () => {},
        newTab: () => {},
        closeTab: () => {},
        stop: () => {},
        submit: () => {},
        edit: () => edited++,
        send: () => sent++,
        undo: () => {},
      },
    );
    const editor = view.dock.children.find((child) => child.kind === "editor");
    expect(editor?.props.key).toBe("composer");
    expect(editor?.props.text).toBe("hello");
    await editor?.handlers?.onEdit?.({} as never);
    await editor?.handlers?.onSend?.({} as never);
    expect(edited).toBe(1);
    expect(sent).toBe(1);
    const button = view.layer.children[0]?.children[1]?.children[0];
    await button?.handlers?.onClick?.({} as ActionEvent);
    expect(approved).toBe(1);
  });
});

describe("native Empryo embedded runner", () => {
  it("resumes the saved session after cancel, and releases waiters on close", async () => {
    const startedFirst = Promise.withResolvers<void>();
    const startedSecond = Promise.withResolvers<void>();
    const sessions: string[] = [];
    const prompts: string[] = [];
    const run: RunChat = async (opts) => {
      const iteration = sessions.length;
      sessions.push(opts.sessionId ?? "");
      const prompt = await opts.readPrompt?.();
      if (prompt) prompts.push(prompt);
      if (iteration === 0) {
        startedFirst.resolve();
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) resolve();
          else opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        opts.onEvent?.({
          type: "chat-done",
          turns: 1,
          tokens: TOKENS,
          sessionId: "persisted-session",
        });
      } else {
        startedSecond.resolve();
        await opts.readPrompt?.();
      }
    };
    const events: HeadlessEvent[] = [];
    const runner = new NativeRunner(
      {
        tabId: "tab-a",
        label: "TAB-1",
        config: {} as AppConfig,
        callbacks: {} as InteractiveCallbacks,
        onApproveDestructive: async () => false,
        onApproveOutsideCwd: async () => false,
      },
      (event) => events.push(event),
      run,
    );
    runner.start();
    try {
      expect(runner.enqueue("first")).toBe(true);
      await startedFirst.promise;
      runner.interrupt();
      expect(runner.enqueue("second")).toBe(true);
      await startedSecond.promise;
      expect(prompts).toEqual(["first", "second"]);
      expect(sessions[1]).toBe("persisted-session");
      expect(events.some((event) => event.type === "chat-done")).toBe(true);
    } finally {
      await runner.close();
    }
    expect(runner.enqueue("after-close")).toBe(false);
  });

  it("bounds queued prompts and rejects empty payloads", async () => {
    const runner = new NativeRunner(
      {
        tabId: "tab-a",
        label: "TAB-1",
        config: {} as AppConfig,
        callbacks: {} as InteractiveCallbacks,
        onApproveDestructive: async () => false,
        onApproveOutsideCwd: async () => false,
      },
      () => {},
      async () => {},
    );
    expect(runner.enqueue("   ")).toBe(false);
    for (let i = 0; i < 200; i++) expect(runner.enqueue("p" + String(i))).toBe(true);
    expect(runner.enqueue("overflow")).toBe(false);
    await runner.close();
  });
});
