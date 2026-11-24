import { EventEmitter } from "node:events";
import { describe, expect, it } from "bun:test";
import { Session } from "@stencil-hq/tern";
import { NativeApp } from "../src/components/tern/native-app.js";
import { nativeCliEligible } from "../src/components/tern/native-entry.js";
import { NativeRunner, type RunnerOptions } from "../src/components/tern/native-runner.js";
import { NativeTranscript } from "../src/components/tern/native-transcript.js";
import { bridgeSubagentEvents, headlessToolResult } from "../src/headless/run.js";
import {
  emitAgentStats,
  emitMultiAgentEvent,
  emitSubagentStep,
} from "../src/core/agents/subagent-events.js";
import type { HeadlessEvent } from "../src/headless/types.js";
import type { AppConfig } from "../src/types/index.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const tokens = { input: 0, output: 0, cacheRead: 0 };
const config = { defaultModel: "loopback/test", defaultForgeMode: "default" } as AppConfig;

function runnerOptions(): RunnerOptions {
  return {
    tabId: "tab-a",
    label: "TAB-1",
    config: {} as AppConfig,
    callbacks: {} as RunnerOptions["callbacks"],
    onApproveDestructive: async () => false,
    onApproveOutsideCwd: async () => false,
  };
}

describe("real producer to native projection", () => {
  it("retains complete failure output, error, and stable call identity", () => {
    const transcript = new NativeTranscript();
    transcript.submit("delete a file");
    transcript.receive({
      type: "tool-call", tool: "shell", toolCallId: "shell-1",
      input: { command: "rm -rf /protected" },
    });
    const fullOutput = "Permission denied:\n" + "detailed failure line\n".repeat(40);
    const event = headlessToolResult({
      toolName: "shell", toolCallId: "shell-1",
      output: { success: false, output: fullOutput, error: "Operation rejected" },
    });
    expect(event.summary.length).toBeLessThanOrEqual(201);
    expect(event.output).toBe(fullOutput);
    expect(event.success).toBe(false);
    transcript.receive(event);
    const card = transcript.project()[1]?.c?.[0];
    expect(card?.id).toBe("tool.shell-1");
    expect(card?.p?.status).toBe("error");
    expect(String(card?.c?.[0]?.p?.text)).toContain(fullOutput);
    expect(String(card?.c?.[0]?.p?.text)).toContain("Operation rejected");
    const ok = headlessToolResult({
      toolName: "read", toolCallId: "read-2",
      output: { success: true, output: "line".repeat(100) },
    });
    expect(ok.output?.length).toBe(400);
    expect(ok.summary.length).toBeLessThanOrEqual(201);
  });

  it("bridges actual core subagent emitter with parent tool and stream ownership", () => {
    const transcript = new NativeTranscript();
    transcript.submit("research");
    transcript.receive({ type: "tool-call", tool: "dispatch", toolCallId: "parent-A" });
    const events: HeadlessEvent[] = [];
    const release = bridgeSubagentEvents((event) => {
      events.push(event);
      transcript.receive(event);
    }, new Set(["parent-A"]));
    try {
      emitMultiAgentEvent({
        parentToolCallId: "parent-B", type: "agent-start", agentId: "foreign",
      });
      emitMultiAgentEvent({
        parentToolCallId: "parent-A", type: "dispatch-start", totalAgents: 1,
      });
      emitMultiAgentEvent({
        parentToolCallId: "parent-A", type: "agent-start",
        agentId: "researcher-1", role: "explore", task: "Read source files",
      });
      emitSubagentStep({
        parentToolCallId: "parent-A", agentId: "researcher-1",
        toolName: "read", args: "src/main.ts", state: "running", backend: "lsp",
      });
      emitAgentStats({
        parentToolCallId: "parent-A", agentId: "researcher-1",
        toolUses: 1, stepCount: 1, tokenUsage: { input: 8, output: 7, total: 15 },
        cacheHits: 0, cacheWrite: 0,
      });
      emitMultiAgentEvent({
        parentToolCallId: "parent-A", type: "agent-done",
        agentId: "researcher-1", succeeded: true, resultChars: 30,
      });
      emitSubagentStep({
        parentToolCallId: "parent-A", agentId: "researcher-1",
        toolName: "read", state: "done",
      });
      emitMultiAgentEvent({
        parentToolCallId: "parent-A", type: "dispatch-done",
        completedAgents: 1, totalAgents: 1,
      });
    } finally {
      release();
    }
    const seenBeforeDispose = events.length;
    emitMultiAgentEvent({ parentToolCallId: "parent-A", type: "agent-start", agentId: "late" });
    expect(events).toHaveLength(seenBeforeDispose);
    expect(events.every((event) => "event" in event && event.event.parentToolCallId === "parent-A")).toBe(true);
    const parent = transcript.project()[1]?.c?.find((n) => n.id === "tool.parent-A");
    expect(parent).toBeDefined();
    const agent = parent?.c?.find((n) => n.id === "agent.parent-A.agent.researcher-1");
    expect(agent?.p?.status).toBe("done");
    expect(agent?.p?.target).toBe("Read source files");
    expect(parent?.c?.some((n) => n.id === "agent.parent-A.step.researcher-1.read" && n.p?.status === "done")).toBe(true);
    expect(parent?.c?.some((n) => n.id.includes("foreign"))).toBe(false);
    expect(tokens.input).toBe(0);
  });
});

describe("native runner failure lifecycle", () => {
  it("reports setup rejection, rejects new prompts and settles close", async () => {
    const events: HeadlessEvent[] = [];
    const runner = new NativeRunner(runnerOptions(), (event) => events.push(event),
      async () => { throw new Error("invalid embedded model"); });
    runner.start();
    expect(runner.enqueue("request")).toBe(true);
    await flush();
    expect(events.some((event) => event.type === "error" && event.error === "invalid embedded model")).toBe(true);
    expect(runner.enqueue("orphan")).toBe(false);
    await runner.close();
  });

  it("embedded invalid model rejects to its owner rather than exiting the host", async () => {
    const { runChat } = await import("../src/headless/run.js");
    await expect(runChat({
      embedded: true,
      modelId: "none",
      readPrompt: async () => null,
    }, config)).rejects.toThrow("No model configured");
  });

  it("does not invoke the engine after close-before-start", async () => {
    let invoked = false;
    const runner = new NativeRunner(runnerOptions(), () => {}, async () => { invoked = true; });
    await runner.close();
    runner.start();
    await flush();
    expect(invoked).toBe(false);
    expect(runner.enqueue("orphan")).toBe(false);
  });

  it("settles active and queued projections on engine rejection", () => {
    const transcript = new NativeTranscript();
    transcript.submit("first");
    transcript.submit("second");
    transcript.receive({ type: "tool-call", tool: "shell", toolCallId: "shell" });
    transcript.receive({ type: "error", error: "engine crashed" });
    expect(transcript.busy).toBe(false);
    expect(transcript.queued).toEqual([]);
    expect(transcript.project()[1]?.c?.[0]?.p?.status).toBe("error");
    transcript.receive({ type: "chat-done", turns: 1, tokens });
    expect(transcript.busy).toBe(false);
  });
});

describe("OpenTUI CLI fallback", () => {
  it("does not steal native-unsupported resume, wizard, plugin or preset intent", () => {
    expect(nativeCliEligible([])).toBe(true);
    for (const args of [
      ["--resume", "saved-id"], ["--session", "saved-id"], ["--wizard"],
      ["--presets"], ["--plugin", "owner/repo"], ["--cwd", "/tmp"],
    ]) {
      expect(nativeCliEligible(args)).toBe(false);
    }
  });
});

describe("native SDK controller and queued ownership", () => {
  it("renders unique per-instance IDs and ignores old A edit/send/stop/close after switching to B", async () => {
    const tern = new Session(new EventEmitter(), { write() {} }, { exitHooks: false, record: "" });
    const rendered: Array<ReturnType<typeof import("../src/components/tern/native-view.js").nativeView>> = [];
    const optsByTab: RunnerOptions[] = [];
    const originalOpen = tern.open.bind(tern);
    tern.open = ((options) => {
      const surface = originalOpen(options);
      const originalRender = surface.render.bind(surface);
      surface.render = (view) => {
        rendered.push(view as typeof rendered[number]);
        originalRender(view);
      };
      return surface;
    }) as typeof tern.open;
    const app = new NativeApp(tern, config, (options, emit) => {
      optsByTab.push(options);
      return new NativeRunner(options, emit, async (run) => {
        for (;;) {
          const prompt = await run.readPrompt?.();
          if (prompt === null) return;
          if (run.signal?.aborted) return;
        }
      });
    });
    const running = app.run();
    try {
      const first = rendered.at(-1);
      expect(first).toBeDefined();
      const aEditor = first?.dock.children.find((n) => n.kind === "editor");
      expect(aEditor).toBeDefined();
      await aEditor?.handlers?.onSend?.({ text: "A work", raw: {} } as never);
      await flush();
      const busyA = rendered.at(-1);
      const stopA = busyA?.dock.children.at(-1)?.children.at(-1)?.handlers?.onClick;
      const closeA = busyA?.dock.children[0]?.children.at(-1)?.handlers?.onClick;
      const newTab = busyA?.dock.children[0]?.children.at(-2)?.handlers?.onClick;
      expect(stopA).toBeTypeOf("function");
      expect(closeA).toBeTypeOf("function");
      await newTab?.({} as never);
      await flush();
      const second = rendered.at(-1);
      expect(second).toBeDefined();
      const bEditor = second?.dock.children.find((n) => n.kind === "editor");
      const beforeB = bEditor?.props.text;
      expect(aEditor?.props.key).not.toBe(bEditor?.props.key);
      // Both retained handler closures and a delayed SDK node-id event are hostile inputs.
      await aEditor?.handlers?.onEdit?.({ from: 0, to: 0, cursor: 6, text: "stale!" } as never);
      await aEditor?.handlers?.onSend?.({ text: "stale submit" } as never);
      await stopA?.({} as never);
      await closeA?.({} as never);
      const surface = tern.surfaces[0];
      const staleId = "dock." + String(aEditor?.props.key);
      const staleSend = surface?.dispatch({
        ev: "send", id: staleId, sf: "empryo", raw: {}, text: "stale sdk event",
      });
      await staleSend?.();
      await flush();
      const bAfter = rendered.at(-1);
      expect(bAfter?.dock.children.find((n) => n.kind === "editor")?.props.text).toBe(beforeB);
      expect(bAfter?.dock.children[0]?.children.length).toBe(4);
      expect(optsByTab).toHaveLength(2);
    } finally {
      await tern.close();
      await running;
    }
  });

  it("denies invisible inactive approvals, and orders concurrent modal ownership", async () => {
    const tern = new Session(new EventEmitter(), { write() {} }, { exitHooks: false, record: "" });
    const rendered: Array<ReturnType<typeof import("../src/components/tern/native-view.js").nativeView>> = [];
    const options: RunnerOptions[] = [];
    const open = tern.open.bind(tern);
    tern.open = ((args) => {
      const surface = open(args);
      const render = surface.render.bind(surface);
      surface.render = (view) => { rendered.push(view as typeof rendered[number]); render(view); };
      return surface;
    }) as typeof tern.open;
    const app = new NativeApp(tern, config, (opts, emit) => {
      options.push(opts);
      return new NativeRunner(opts, emit, async (run) => {
        await run.readPrompt?.();
        await run.readPrompt?.();
      });
    });
    const running = app.run();
    try {
      await rendered.at(-1)?.dock.children[0]?.children.at(-2)?.handlers?.onClick?.({} as never);
      await flush();
      expect(options).toHaveLength(2);
      // A is inactive, so request never enters the global modal stack.
      expect(await options[0]?.onApproveDestructive("danger")).toBe(false);
      const firstB = options[1]!.callbacks.onAskUser("Question one", [{ label: "yes", value: "yes" }], false);
      const secondB = options[1]!.onApproveDestructive("Question two");
      await flush();
      let top = rendered.at(-1)?.layer.children[0];
      expect(top?.props.head).toBe("Destructive operation");
      const staleTop = top?.children.at(-1)?.children.at(-1)?.handlers?.onClick;
      // The destructive prompt is top; deny it, revealing first B prompt.
      const deny = top?.children.at(-1)?.children.at(-1)?.handlers?.onClick;
      await deny?.({} as never);
      expect(await secondB).toBe(false);
      await flush();
      top = rendered.at(-1)?.layer.children[0];
      await staleTop?.({} as never);
      const yes = top?.children.at(-1)?.children[0]?.handlers?.onClick;
      await yes?.({} as never);
      expect(await firstB).toBe("yes");
      const typed = options[1]!.callbacks.onAskUser("No options", [], false);
      await flush();
      const textModal = rendered.at(-1)?.layer.children[0];
      await textModal?.children.find((n) => n.kind === "editor")?.handlers?.onSend?.({
        text: "written answer",
      } as never);
      expect(await typed).toBe("written answer");
    } finally {
      await tern.close();
      await running;
    }
  });
});
