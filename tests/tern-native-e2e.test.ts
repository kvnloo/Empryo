import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  connect,
  encodeMessage,
  node,
  type Session,
  type TermInput,
  type TermOutput,
  type WireNode,
} from "@stencil-hq/tern";
import { NativeApp } from "../src/components/tern/native-app.js";
import { NativeRunner, type RunnerOptions } from "../src/components/tern/native-runner.js";
import type { AppConfig } from "../src/types/index.js";

interface Frame {
  sf: string;
  s: number;
  ops: unknown[][];
}
interface Recorded {
  dir: string;
  verb: string;
  body: unknown;
}

class ByteTty extends EventEmitter implements TermInput {
  readonly isTTY = true;
  isRaw = false;
  resumed = false;
  setRawMode(mode: boolean): void {
    this.isRaw = mode;
  }
  resume(): void {
    this.resumed = true;
  }
  pause(): void {
    this.resumed = false;
  }
  feed(bytes: Uint8Array | string): void {
    this.emit("data", bytes);
  }
}

class ByteOutput implements TermOutput {
  readonly isTTY = true;
  readonly columns = 110;
  readonly messages: Array<{ verb: string; body: unknown }> = [];
  onHello: (() => void) | undefined;
  #buffer = "";

  write(data: Uint8Array | string): void {
    this.#buffer += typeof data === "string" ? data : Buffer.from(data).toString("utf-8");
    for (;;) {
      const start = this.#buffer.indexOf("\x1b_tsp;");
      if (start === -1) {
        this.#buffer = this.#buffer.slice(-32);
        return;
      }
      const end = this.#buffer.indexOf("\x1b\\", start);
      if (end === -1) {
        this.#buffer = this.#buffer.slice(start);
        return;
      }
      const message = this.#buffer.slice(start + 6, end);
      this.#buffer = this.#buffer.slice(end + 2);
      const semi = message.indexOf(";");
      const verb = message.slice(0, semi);
      const body = JSON.parse(message.slice(semi + 1)) as unknown;
      this.messages.push({ verb, body });
      if (verb === "q" && (body as { q?: string }).q === "hello") this.onHello?.();
    }
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function recordPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "empryo-trn3-"));
  roots.push(dir);
  return join(dir, "sdk-record.jsonl");
}
function event(input: ByteTty, value: Record<string, unknown>): void {
  input.feed(encodeMessage("e", JSON.stringify(value)));
}
function frames(output: ByteOutput): Frame[] {
  return output.messages.filter((message) => message.verb === "f").map((message) => message.body as Frame);
}
function findWire(node: WireNode, predicate: (n: WireNode) => boolean): WireNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.c ?? []) {
    const found = findWire(child, predicate);
    if (found) return found;
  }
  return undefined;
}
function findAdded(output: ByteOutput, predicate: (n: WireNode) => boolean): WireNode | undefined {
  for (const frame of frames(output).toReversed()) {
    for (const op of frame.ops) {
      if (op[0] === "add") {
        const found = findWire(op[4] as WireNode, predicate);
        if (found) return found;
      }
    }
  }
  return undefined;
}
async function eventually<T>(check: () => T | undefined | null | false, ms = 1500): Promise<T> {
  const deadline = Date.now() + ms;
  do {
    const result = check();
    if (result) return result;
    await Bun.sleep(5);
  } while (Date.now() < deadline);
  throw new Error("Tern fixture condition never became true");
}
function connectedDevice(options: { credits?: number; reply?: boolean; path?: string } = {}) {
  const input = new ByteTty();
  const output = new ByteOutput();
  if (options.reply !== false) {
    output.onHello = () => {
      queueMicrotask(() => input.feed(encodeMessage("r", JSON.stringify({
        r: "hello", v: 1, term: "trn3-fixture", ver: "1",
        credits: options.credits ?? 2, cols: 110,
      }))));
      output.onHello = undefined;
    };
  }
  return {
    input, output,
    connect: () => connect({
      app: "empryo", input, output, env: {}, timeout: 90,
      exitHooks: false, ...(options.path ? { record: options.path } : {}),
    }),
  };
}
function recorded(path: string): Recorded[] {
  return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Recorded);
}

/** Replay real recorded TSP ops, not just the in-memory view object. */
function replayRecordedFrames(log: readonly Frame[]): {
  nodes: Map<string, { kind: string; props: Record<string, unknown> }>;
  focus: string | null;
} {
  const nodes = new Map<string, { kind: string; props: Record<string, unknown> }>();
  let focus: string | null = null;
  const add = (wire: WireNode): void => {
    nodes.set(wire.id, { kind: wire.k, props: { ...wire.p } });
    for (const child of wire.c ?? []) add(child);
  };
  for (const frame of log) {
    for (const op of frame.ops) {
      const id = typeof op[1] === "string" ? op[1] : "";
      if (op[0] === "add") {
        add(op[4] as WireNode);
      } else if (op[0] === "del") {
        for (const key of nodes.keys()) {
          if (key === id || key.startsWith(id + ".")) nodes.delete(key);
        }
      } else if (op[0] === "set") {
        const target = nodes.get(id);
        if (target) Object.assign(target.props, op[2] as Record<string, unknown>);
      } else if (op[0] === "text") {
        const target = nodes.get(id);
        if (target) {
          const previous = typeof target.props.text === "string" ? target.props.text : "";
          const value = String(op[3] ?? "");
          target.props.text = op[2] === "append" ? previous + value : value;
        }
      } else if (op[0] === "splice") {
        const target = nodes.get(id);
        if (target) {
          const previous = typeof target.props.text === "string" ? target.props.text : "";
          target.props.text = previous.slice(0, Number(op[2])) +
            String(op[4] ?? "") + previous.slice(Number(op[2]) + Number(op[3]));
        }
      } else if (op[0] === "focus") {
        focus = op[1] as string | null;
      }
    }
  }
  return { nodes, focus };
}

describe("real Tern connect(), Session and Surface protocol", () => {
  it("refuses non-TTY and TERN_TSP=0 without touching the input", async () => {
    const host = connectedDevice();
    expect(await connect({
      input: { ...host.input, isTTY: false } as TermInput,
      output: host.output, env: {}, exitHooks: false,
    })).toBeNull();
    expect(await connect({
      input: host.input, output: host.output,
      env: { TERN_TSP: "0" }, exitHooks: false,
    })).toBeNull();
    expect(host.input.isRaw).toBe(false);
    expect(host.output.messages).toHaveLength(0);
  });

  it("restores raw mode on DA1 refusal and real handshake timeout", async () => {
    const da1 = connectedDevice({ reply: false });
    da1.output.onHello = () => queueMicrotask(() => da1.input.feed("\x1b[?1;2c"));
    expect(await da1.connect()).toBeNull();
    expect(da1.input.isRaw).toBe(false);
    expect(da1.input.resumed).toBe(false);

    const timeout = connectedDevice({ reply: false });
    expect(await timeout.connect()).toBeNull();
    expect(timeout.input.isRaw).toBe(false);
    expect(timeout.input.resumed).toBe(false);
  });

  it("records actual SDK frames, coalesces starved credits, replays latest nodes and closes", async () => {
    const path = recordPath();
    const host = connectedDevice({ credits: 1, path });
    const session = await host.connect();
    expect(session).not.toBeNull();
    if (!session) return;
    try {
      expect(session.caps.credits).toBe(1);
      expect(host.input.isRaw).toBe(true);
      const surface = session.open({ id: "empryo", role: "omp.session" });
      surface.render({
        main: node("col", { key: "root" }, [
          node("text", { key: "stable" }, "BASE"),
        ]),
      });
      expect(surface.blocked).toBe(true);
      const firstSequence = surface.seq;
      surface.render({
        main: node("col", { key: "root" }, [
          node("text", { key: "stable" }, "INTERMEDIATE_SHOULD_NOT_APPEAR"),
        ]),
      });
      surface.render({
        main: node("col", { key: "root" }, [
          node("text", { key: "stable" }, "FINAL"),
          node("text", { key: "new" }, "LATEST_ONLY"),
        ]),
      });
      surface.focus("main.new");
      expect(frames(host.output)).toHaveLength(1);
      event(host.input, { ev: "ack", sf: "empryo", s: firstSequence });
      await eventually(() => frames(host.output).length === 2);
      const sent = frames(host.output);
      expect(sent[1]?.s).toBe(firstSequence + 1);
      const replay = sent.flatMap((frame) => frame.ops);
      // The TSP op log is replayable in order: the final diff has both
      // replaced text and the newly added node, plus the queued focus.
      expect(replay).toContainEqual(["text", "main.stable", "replace", "FINAL"]);
      expect(replay.some((op) => op[0] === "add" && JSON.stringify(op).includes("LATEST_ONLY"))).toBe(true);
      expect(replay).toContainEqual(["focus", "main.new"]);
      expect(JSON.stringify(sent)).not.toContain("INTERMEDIATE_SHOULD_NOT_APPEAR");
      expect(surface.blocked).toBe(true);
      event(host.input, { ev: "ack", sf: "empryo", s: sent[1]?.s });
      await eventually(() => !surface.blocked);
      expect(surface.closed).toBe(false);
    } finally {
      await session.close();
    }
    expect(host.input.isRaw).toBe(false);
    expect(host.input.resumed).toBe(false);
    const log = recorded(path);
    expect(log.some((item) => item.dir === "out" && item.verb === "q")).toBe(true);
    expect(log.some((item) => item.dir === "in" && item.verb === "r")).toBe(true);
    expect(log.filter((item) => item.dir === "out" && item.verb === "f")).toHaveLength(2);
    expect(log.some((item) => item.dir === "in" && item.verb === "e" &&
      (item.body as { ev: string }).ev === "ack")).toBe(true);
    expect(log.some((item) => item.dir === "out" && item.verb === "x")).toBe(true);
    const recordedFrames = log.filter((item) => item.dir === "out" && item.verb === "f")
      .map((item) => item.body as Frame);
    expect(recordedFrames).toEqual(frames(host.output));
    const replayed = replayRecordedFrames(recordedFrames);
    expect(replayed.nodes.get("main.stable")?.props.text).toBe("FINAL");
    expect(replayed.nodes.get("main.new")?.props.text).toBe("LATEST_ONLY");
    expect(replayed.focus).toBe("main.new");
    expect(JSON.stringify([...replayed.nodes.values()])).not.toContain("INTERMEDIATE_SHOULD_NOT_APPEAR");
  });
});

describe("SDK-routed native controller actions (separate from real-provider PTY smoke)", () => {
  const config = {
    defaultModel: "ollama/trn3-fixture",
    defaultForgeMode: "default",
  } as AppConfig;

  it("decodes raw Unicode/paste, routes edit/undo/send and explicit deny/approve, then cleans up on gone", async () => {
    const host = connectedDevice({ credits: 20 });
    const session = await host.connect();
    expect(session).not.toBeNull();
    if (!session) return;
    const received: string[] = [];
    const options: RunnerOptions[] = [];
    // This replacement only observes controller routing. The separate OS-PTY
    // smoke uses NO runner injection and executes the real Ollama adapter.
    const app = new NativeApp(session, config, (opts, emit) => {
      options.push(opts);
      return new NativeRunner(opts, emit, async (run) => {
        for (;;) {
          const prompt = await run.readPrompt?.();
          if (prompt === null || prompt === undefined) return;
          received.push(prompt);
          run.onEvent?.({
            type: "turn-done", turn: received.length, output: "synthetic",
            tokens: { input: 1, output: 1, cacheRead: 0 },
            steps: 0, toolCalls: [], filesEdited: [], duration: 1,
          });
        }
      });
    });
    const running = app.run();
    try {
      const editor = await eventually(() => findAdded(host.output,
        (n) => n.k === "editor" && n.p?.role === "omp.editor" && n.id.startsWith("dock.")));
      // Three writes to the tty's raw byte path, not fabricated edit events.
      host.input.feed(new TextEncoder().encode("hello "));
      const emoji = new TextEncoder().encode("é😀");
      for (const byte of emoji) host.input.feed(Uint8Array.of(byte));
      host.input.feed(new TextEncoder().encode("\x1b[200~ pasted\nλ\x1b[201~"));
      host.input.feed(Uint8Array.of(13));
      await eventually(() => received.length === 1);
      expect(received).toEqual(["hello é😀 pasted\nλ"]);

      // Native edit/undo/send is a distinct, supported TSP action path.
      event(host.input, {
        ev: "edit", sf: "empryo", id: editor.id, from: 0, to: 0,
        text: "temporary", cursor: 9, len: 9,
      });
      await Bun.sleep(10);
      event(host.input, { ev: "undo", sf: "empryo", id: editor.id });
      await Bun.sleep(10);
      event(host.input, {
        ev: "edit", sf: "empryo", id: editor.id, from: 0, to: 0,
        text: "TSP native", cursor: 10, len: 10,
      });
      await Bun.sleep(10);
      event(host.input, { ev: "send", sf: "empryo", id: editor.id, text: "TSP native" });
      await eventually(() => received.length === 2);
      expect(received[1]).toBe("TSP native");

      const denyDecision = options[0]?.onApproveDestructive("synthetic destructive request");
      expect(denyDecision).toBeDefined();
      const deny = await eventually(() => findAdded(host.output,
        (n) => n.k === "text" && n.p?.text === "Deny" &&
        n.p?.role === "omp.modal.action"));
      event(host.input, { ev: "action", sf: "empryo", id: deny.id, act: "click" });
      expect(await denyDecision).toBe(false);

      const beforeAllow = frames(host.output).length;
      const allowDecision = options[0]?.onApproveDestructive("synthetic allowed request");
      const allow = await eventually(() => {
        for (const frame of frames(host.output).slice(beforeAllow)) {
          for (const op of frame.ops) {
            if (op[0] !== "add") continue;
            const found = findWire(op[4] as WireNode, (n) =>
              n.k === "text" && n.p?.text === "Allow once" &&
              n.p?.role === "omp.modal.action");
            if (found) return found;
          }
        }
        return undefined;
      });
      event(host.input, { ev: "action", sf: "empryo", id: allow.id, act: "click" });
      expect(await allowDecision).toBe(true);

      // Terminal-dropped surface is not an approval: run() must retire the
      // engine, close its SDK Session and restore raw mode.
      event(host.input, { ev: "gone", sf: "empryo", ids: ["empryo"] });
      await running;
      expect(session.closed).toBe(true);
      expect(host.input.isRaw).toBe(false);
      expect(session.surfaces).toHaveLength(0);
    } finally {
      await session.close();
    }
  }, 10_000);
});
