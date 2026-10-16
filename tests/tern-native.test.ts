import { describe, expect, it } from "bun:test";
import { OverlayOwners, SubmissionGate } from "../src/components/tern/action-guards.js";
import { busyFrom, ownsEvent, Switches } from "../src/components/tern/flow.js";
import {
  projectLiveTool,
  projectMessage,
  projectTool,
} from "../src/components/tern/projection.js";
import type { ChatMessage, ToolCall } from "../src/types/index.js";

describe("Tern native session ownership (ported from Hermes preview)", () => {
  it("rejects a superseded asynchronous session switch", () => {
    const s = new Switches();
    const old = s.begin();
    const latest = s.begin();
    s.end(old);
    expect(s.pending).toBe(true);
    expect(s.current(old)).toBe(false);
    expect(s.current(latest)).toBe(true);
    s.end(latest);
    expect(s.pending).toBe(false);
  });

  it("holds foreign prompts during a switch, drops them after", () => {
    const s = new Switches();
    expect(s.route("a", "b")).toBe("drop");
    const token = s.begin();
    expect(s.route("a", "b")).toBe("hold");
    expect(s.route("a", "a")).toBe("show");
    s.end(token);
    expect(s.route("a", "b")).toBe("drop");
  });

  it("filters stale session events while retaining global events", () => {
    expect(ownsEvent("a", { type: "message.delta", session_id: "b" })).toBe(false);
    expect(ownsEvent("a", { type: "message.delta", session_id: "a" })).toBe(true);
    expect(ownsEvent("a", { type: "gateway.ready", session_id: "b" })).toBe(true);
    expect(busyFrom({ running: true, turn_started_at: 100 }, 5)?.startedAt).toBe(100000);
  });
});

describe("Tern projection of Empryo messages", () => {
  const read: ToolCall = {
    id: "read-1",
    name: "read_file",
    args: { path: "src/index.ts" },
    result: { success: true, output: "hello" },
  };

  it("uses Empryo's native chat message IDs and roles", () => {
    const user: ChatMessage = { id: "u1", role: "user", content: "hello", timestamp: 1 };
    expect(projectMessage(user).id).toBe("message.u1");
    expect(projectMessage(user).p?.role).toBe("omp.user");
  });

  it("keeps thinking, tool and text blocks in arrival order", () => {
    const msg: ChatMessage = {
      id: "a1", role: "assistant", content: "", timestamp: 2,
      toolCalls: [read],
      segments: [
        { type: "reasoning", id: "think-1", content: "checking" },
        { type: "tools", toolCallIds: ["read-1"] },
        { type: "text", content: "done" },
      ],
    };
    const nodes = projectMessage(msg).c ?? [];
    expect(nodes.map((n) => n.k)).toEqual(["md", "tool", "md"]);
    expect(nodes[0]?.p?.role).toBe("omp.thinking");
    expect(nodes[1]?.p?.name).toBe("read");
    expect(nodes[2]?.p?.text).toBe("done");
  });

  it("keeps unsegmented tools instead of dropping results", () => {
    const msg: ChatMessage = {
      id: "a2", role: "assistant", content: "answer", timestamp: 2,
      segments: [{ type: "text", content: "answer" }],
      toolCalls: [read],
    };
    expect(projectMessage(msg).c?.map((n) => n.id)).toEqual([
      "message.a2.text.0",
      "tool.read-1",
    ]);
  });

  it("preserves stable tool IDs as live calls settle", () => {
    const running = projectLiveTool({ id: "tool-1", toolName: "shell", state: "running", progressText: "working" });
    const settled = projectTool({ id: "tool-1", name: "shell", args: {}, result: { success: true, output: "ok" } });
    expect(running.id).toBe(settled.id);
    expect(running.p?.name).toBe("bash");
    expect(settled.p?.status).toBe("done");
  });

  it("shows failed tools rather than silently dropping errors", () => {
    const tool = projectTool({ id: "t1", name: "dispatch", args: {}, result: { success: false, output: "", error: "failed" } });
    expect(tool.p?.status).toBe("error");
    expect(tool.p?.name).toBe("task");
    expect(tool.c?.[0]?.p?.text).toBe("failed");
  });
});

describe("Tern native action guards", () => {
  it("rejects an older instance's queued action after an overlay is replaced", () => {
    const guard = new OverlayOwners();
    let called = 0;
    const first = guard.open("approve");
    const queuedOld = guard.guard(first, () => { called++; });
    const second = guard.open("approve");
    queuedOld();
    expect(called).toBe(0);
    guard.guard(second, () => { called++; })();
    expect(called).toBe(1);
    guard.close(second);
    guard.guard(second, () => { called++; })();
    expect(called).toBe(1);
  });

  it("only allows the current top modal to act", () => {
    const guard = new OverlayOwners();
    const first = guard.open("permissions");
    const second = guard.open("model");
    expect(guard.isTop(first)).toBe(false);
    expect(guard.isTop(second)).toBe(true);
    guard.close(second);
    expect(guard.isTop(first)).toBe(true);
  });

  it("prevents duplicate native and keyboard sends for one draft", () => {
    const gate = new SubmissionGate();
    expect(gate.consume("session-1", 4, "hello\nworld")).toBe("hello\nworld");
    expect(gate.consume("session-1", 4, "hello\nworld")).toBeNull();
    expect(gate.consume("session-1", 5, "hello\nworld")).toBe("hello\nworld");
    expect(gate.consume(null, 6, "message")).toBeNull();
    expect(gate.consume("session-1", 7, "  ")).toBeNull();
  });
});
