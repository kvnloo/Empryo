/**
 * Runs Empryo's public, authoritative runChat engine in embedded mode.
 * Each tab has a persistent session ID, a bounded prompt queue, and an
 * abort/restart cycle. No Hermes backend or duplicated agent dispatch.
 */
import { randomUUID } from "node:crypto";
import type { HeadlessChatOptions, HeadlessEvent } from "../../headless/types.js";
import type { AppConfig, ForgeMode, InteractiveCallbacks } from "../../types/index.js";

const MAX_QUEUED = 200;

export interface RunnerOptions {
  tabId: string;
  label: string;
  config: AppConfig;
  callbacks: InteractiveCallbacks;
  onApproveDestructive: (description: string) => Promise<boolean>;
  onApproveOutsideCwd: (toolName: string, path: string) => Promise<boolean>;
  mode?: ForgeMode;
}

export type RunChat = (options: HeadlessChatOptions, config: AppConfig) => Promise<void>;

export class NativeRunner {
  #sessionId = randomUUID();
  #queue: string[] = [];
  #waiters: Array<(value: string | null) => void> = [];
  #controller = new AbortController();
  #task: Promise<void> | null = null;
  #closed = false;
  #ended = false;

  constructor(
    private readonly options: RunnerOptions,
    private readonly emit: (event: HeadlessEvent) => void,
    private readonly run?: RunChat,
  ) {}

  get sessionId(): string {
    return this.#sessionId;
  }

  get queueLength(): number {
    return this.#queue.length;
  }

  start(): void {
    if (!this.#task && !this.#closed && !this.#ended) this.#task = this.#loop();
  }

  enqueue(text: string): boolean {
    if (this.#closed || this.#ended || !text.trim() || this.#queue.length >= MAX_QUEUED) {
      return false;
    }
    const waiter = this.#waiters.shift();
    if (waiter) waiter(text);
    else this.#queue.push(text);
    return true;
  }

  interrupt(): void {
    if (this.#closed || this.#ended) return;
    this.#controller.abort();
    this.#wake(null);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort();
    this.#queue = [];
    this.#wake(null);
    await this.#task;
  }

  async #loop(): Promise<void> {
    let reportedFailure = false;
    try {
      const execute = this.run ?? (await import("../../headless/run.js")).runChat;
      while (!this.#closed) {
        const ctl = this.#controller;
        try {
          if (ctl.signal.aborted) {
            // Initialization was cancelled before the engine could report a
            // saved turn. Settle the original view before starting its successor.
            if (!this.#closed) {
              this.emit({
                type: "chat-done",
                turns: 0,
                tokens: { input: 0, output: 0, cacheRead: 0 },
                sessionId: this.#sessionId,
              });
            }
          } else {
            await execute(
              {
                tabId: this.options.tabId,
                tabLabel: this.options.label,
                mode: this.options.mode,
                sessionId: this.#sessionId,
                quiet: true,
                embedded: true,
                signal: ctl.signal,
                readPrompt: () => this.#read(),
                callbacks: this.options.callbacks,
                onApproveDestructive: this.options.onApproveDestructive,
                onApproveOutsideCwd: this.options.onApproveOutsideCwd,
                onEvent: (event) => {
                  if (event.type === "chat-done" && event.sessionId) {
                    this.#sessionId = event.sessionId;
                  }
                  if (event.type === "error" && event.error !== "Aborted") reportedFailure = true;
                  if (!this.#closed) this.emit(event);
                },
              },
              this.options.config,
            );
          }
        } catch (error) {
          if (!ctl.signal.aborted && !this.#closed) {
            reportedFailure = true;
            this.emit({
              type: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (!ctl.signal.aborted) break;
        if (!this.#closed) this.#controller = new AbortController();
      }
    } catch (error) {
      if (!this.#closed) {
        reportedFailure = true;
        this.emit({
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.#ended = true;
      this.#queue = [];
      this.#wake(null);
      if (!this.#closed && !reportedFailure) {
        this.emit({ type: "error", error: "Agent session ended unexpectedly." });
      }
    }
  }

  #read(): Promise<string | null> {
    if (this.#closed || this.#controller.signal.aborted) return Promise.resolve(null);
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #wake(value: string | null): void {
    for (const waiter of this.#waiters.splice(0)) waiter(value);
  }
}
