/**
 * Native Tern host for Empryo's existing headless agent. The transcript and
 * permissions are owned by Empryo; Tern owns presentation and input only.
 * UI roles/action ownership follow the Nous Research Hermes MIT preview.
 */
import type { EditEvent, Key, SendEvent, Session, Surface, TspEvent } from "@stencil-hq/tern";
import type { HeadlessEvent } from "../../headless/types.js";
import type {
  AppConfig,
  InteractiveCallbacks,
  Plan,
  PlanReviewAction,
  PlanStepStatus,
} from "../../types/index.js";
import { OverlayOwners, SubmissionGate } from "./action-guards.js";
import { Switches } from "./flow.js";
import { NativeRunner, type RunnerOptions } from "./native-runner.js";
import { NativeTranscript } from "./native-transcript.js";
import { nativeView, type ViewChoice, type ViewModal } from "./native-view.js";

interface Draft {
  text: string;
  cursor: number;
  revision: number;
  undo: Array<{ text: string; cursor: number }>;
}

interface NativeTab {
  id: string;
  label: string;
  transcript: NativeTranscript;
  runner: NativeRunner;
  gate: SubmissionGate;
  draft: Draft;
  lastSent: string | null;
  aborting: string | null;
}

interface Choice {
  id: string;
  label: string;
  value: string;
  tone: "accent" | "neutral" | "error";
}

interface NativePrompt {
  id: string;
  tabId: string;
  owner: string;
  title: string;
  description: string;
  choices: Choice[];
  fallback: string;
  resolve: (value: string) => void;
  allowText: boolean;
  answer: string;
}

const MAX_TABS = 5;
const MAX_UNDO = 100;

export class NativeApp {
  readonly #tabs: NativeTab[] = [];
  readonly #prompts: NativePrompt[] = [];
  readonly #owners = new OverlayOwners();
  readonly #switches = new Switches();
  #activeId = "";
  #surface: Surface | null = null;
  #closed = false;
  #scheduled = false;
  #focusedTab = "";
  #viewEpoch = 0;

  constructor(
    private readonly session: Session,
    private readonly config: AppConfig,
    private readonly makeRunner: (
      options: RunnerOptions,
      emit: (event: HeadlessEvent) => void,
    ) => NativeRunner = (options, emit) => new NativeRunner(options, emit),
  ) {}

  async run(): Promise<void> {
    try {
      this.#surface = this.session.open({
        id: "empryo",
        mode: "inline",
        role: "omp.session",
        title: "Empryo",
      });
      this.#addTab();
      this.#render();
      for await (const input of this.session) {
        if (input.type === "key") {
          if (this.#key(input.key) === "quit") break;
        } else if (this.#event(input.event) === "quit") {
          break;
        }
      }
    } finally {
      this.#closed = true;
      for (const prompt of [...this.#prompts]) this.#finishPrompt(prompt, prompt.fallback);
      try {
        await Promise.allSettled(this.#tabs.map((tab) => tab.runner.close()));
      } finally {
        await this.session.close();
      }
    }
  }

  #addTab(): void {
    if (this.#tabs.length >= MAX_TABS) {
      this.#current()?.transcript.notice("Maximum of five tabs reached.");
      this.#changed();
      return;
    }
    const id = crypto.randomUUID();
    const label = "TAB-" + String(this.#tabs.length + 1);
    const transcript = new NativeTranscript();
    const tab: NativeTab = {
      id,
      label,
      transcript,
      runner: this.makeRunner(
        {
          tabId: id,
          label,
          config: this.config,
          callbacks: this.#callbacks(id),
          mode: this.config.defaultForgeMode,
          onApproveDestructive: (detail) =>
            this.#approve(id, "Destructive operation", detail),
          onApproveOutsideCwd: (tool, path) =>
            this.#approve(id, "Write outside workspace", tool + ": " + path),
        },
        (event) => this.#receive(id, event),
      ),
      gate: new SubmissionGate(),
      draft: { text: "", cursor: 0, revision: 0, undo: [] },
      lastSent: null,
      aborting: null,
    };
    this.#tabs.push(tab);
    this.#select(id);
    tab.runner.start();
  }

  #current(): NativeTab | undefined {
    return this.#tabs.find((tab) => tab.id === this.#activeId);
  }

  #select(id: string): void {
    if (id === this.#activeId) return;
    if (!this.#tabs.some((tab) => tab.id === id)) return;
    const generation = this.#switches.begin();
    const previous = this.#activeId;
    if (previous) this.#cancelPrompts(previous);
    if (!this.#switches.current(generation)) return;
    this.#activeId = id;
    this.#viewEpoch++;
    this.#switches.end(generation);
    this.#changed();
  }

  async #closeActive(expected?: NativeTab): Promise<void> {
    const tab = this.#current();
    if (!tab || (expected && tab !== expected)) return;
    if (this.#tabs.length === 1) {
      await this.session.close();
      return;
    }
    this.#cancelPrompts(tab.id);
    const index = this.#tabs.indexOf(tab);
    this.#tabs.splice(index, 1);
    this.#activeId = "";
    this.#select(this.#tabs[Math.min(index, this.#tabs.length - 1)]?.id ?? "");
    await tab.runner.close();
  }

  #callbacks(tabId: string): InteractiveCallbacks {
    return {
      onPlanCreate: (plan: Plan) => {
        this.#notice(tabId, "Plan: " + plan.title);
      },
      onPlanStepUpdate: (stepId: string, status: PlanStepStatus) => {
        this.#notice(tabId, "Plan step " + stepId + ": " + status);
      },
      onPlanReview: async (plan: Plan, planFile: string, planContent: string): Promise<PlanReviewAction> => {
        const detail = plan.steps.map((step) => "- " + step.label).join("\n");
        return this.#ask(
          tabId,
          "Review plan",
          [plan.title, "Plan file: " + planFile, planContent, "Steps:\n" + detail]
            .filter(Boolean).join("\n\n"),
          [
            { id: "execute", label: "Execute", value: "execute", tone: "accent" },
            {
              id: "clear",
              label: "Clear and execute",
              value: "clear_execute",
              tone: "neutral",
            },
            { id: "cancel", label: "Cancel", value: "cancel", tone: "error" },
          ],
          "cancel",
        );
      },
      onAskUser: async (question, options, allowSkip) => {
        const choices: Choice[] = options.map((option, index) => ({
          id: "option." + String(index),
          label: option.description ? option.label + " — " + option.description : option.label,
          value: option.value,
          tone: "neutral",
        }));
        if (allowSkip) {
          choices.push({ id: "skip", label: "Skip", value: "__skipped__", tone: "neutral" });
        }
        return this.#ask(tabId, "Question", question, choices, allowSkip ? "__skipped__" : "", options.length === 0);
      },
      onOpenEditor: async (path?: string) => {
        this.#notice(
          tabId,
          "External editor requested" +
            (path ? " for " + path : "") +
            ". Reopen in OpenTUI for terminal-editor integration.",
        );
      },
      onWebSearchApproval: (query: string) => this.#approve(tabId, "Web search", query),
      onFetchPageApproval: (url: string) => this.#approve(tabId, "Fetch web page", url),
    };
  }

  #approve(tabId: string, title: string, description: string): Promise<boolean> {
    return this.#ask(
      tabId,
      title,
      description,
      [
        { id: "allow", label: "Allow once", value: "allow", tone: "accent" },
        { id: "deny", label: "Deny", value: "deny", tone: "error" },
      ],
      "deny",
    ).then((choice) => choice === "allow");
  }

  #ask(
    tabId: string,
    title: string,
    description: string,
    choices: Choice[],
    fallback: string,
    allowText = false,
  ): Promise<string> {
    // A background permission request has no visible authority surface.
    if (this.#closed || this.#activeId !== tabId || !this.#tabs.some((tab) => tab.id === tabId)) {
      return Promise.resolve(fallback);
    }
    const id = crypto.randomUUID();
    const owner = this.#owners.open(tabId + ":" + id);
    return new Promise((resolve) => {
      this.#prompts.push({
        id,
        tabId,
        owner,
        title,
        description,
        choices,
        fallback,
        resolve,
        allowText,
        answer: "",
      });
      this.#changed();
    });
  }

  #finishPrompt(prompt: NativePrompt, value: string): void {
    const index = this.#prompts.indexOf(prompt);
    if (index < 0) return;
    this.#prompts.splice(index, 1);
    this.#owners.close(prompt.owner);
    prompt.resolve(value);
    this.#changed();
  }

  #cancelPrompts(tabId: string): void {
    for (const prompt of [...this.#prompts]) {
      if (prompt.tabId === tabId) this.#finishPrompt(prompt, prompt.fallback);
    }
  }

  #currentPrompt(tabId: string): NativePrompt | undefined {
    return this.#prompts.findLast((prompt) => prompt.tabId === tabId);
  }

  #modal(tabId: string): ViewModal | null {
    const prompt = this.#currentPrompt(tabId);
    if (!prompt) return null;
    const choices: ViewChoice[] = prompt.choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
      tone: choice.tone,
      activate: this.#owners.guard(prompt.owner, () => {
        if (this.#activeId === prompt.tabId && this.#currentPrompt(tabId) === prompt) {
          this.#finishPrompt(prompt, choice.value);
        }
      }),
    }));
    return {
      id: prompt.id,
      title: prompt.title,
      description: prompt.description,
      choices,
      answer: prompt.allowText
        ? {
            text: prompt.answer,
            edit: (event: EditEvent) =>
              this.#owners.guard(prompt.owner, () => {
                if (this.#activeId !== tabId || this.#currentPrompt(tabId) !== prompt) return;
                if (
                  !Number.isSafeInteger(event.from) ||
                  !Number.isSafeInteger(event.to) ||
                  event.from < 0 ||
                  event.to < event.from ||
                  event.to > prompt.answer.length
                ) {
                  return;
                }
                prompt.answer =
                  prompt.answer.slice(0, event.from) +
                  event.text +
                  prompt.answer.slice(event.to);
                this.#changed();
              })(),
            send: (event: SendEvent) =>
              this.#owners.guard(prompt.owner, () => {
                if (
                  this.#activeId === tabId &&
                  this.#currentPrompt(tabId) === prompt &&
                  event.text.trim()
                ) {
                  this.#finishPrompt(prompt, event.text);
                }
              })(),
            submit: this.#owners.guard(prompt.owner, () => {
              if (
                this.#activeId === tabId &&
                this.#currentPrompt(tabId) === prompt &&
                prompt.answer.trim()
              ) {
                this.#finishPrompt(prompt, prompt.answer);
              }
            }),
          }
        : undefined,
    };
  }

  #notice(tabId: string, message: string): void {
    const tab = this.#tabs.find((candidate) => candidate.id === tabId);
    if (!tab || this.#closed) return;
    tab.transcript.notice(message);
    this.#changed();
  }

  #receive(tabId: string, event: HeadlessEvent): void {
    const tab = this.#tabs.find((candidate) => candidate.id === tabId);
    if (!tab || this.#closed) return;
    if (tab.aborting && event.type === "error" && event.error === "Aborted") return;
    if (tab.aborting && event.type === "turn-done") {
      if (tab.transcript.activeMessageId === tab.aborting) tab.transcript.interrupt();
      tab.aborting = null;
      this.#changed();
      return;
    }
    if (event.type === "error" && !tab.aborting) this.#cancelPrompts(tab.id);
    if (event.type === "chat-done" && tab.aborting) {
      // A streamed turn-done may already have advanced to the queued prompt.
      // Only drop the turn the user actually interrupted.
      if (tab.transcript.activeMessageId === tab.aborting) tab.transcript.interrupt();
      tab.aborting = null;
    } else {
      tab.transcript.receive(event);
    }
    this.#changed();
  }

  #stop(tabId: string): void {
    const tab = this.#current();
    if (tab?.id !== tabId) return;
    if (!tab?.transcript.busy) return;
    tab.aborting = tab.transcript.activeMessageId;
    this.#cancelPrompts(tab.id);
    tab.runner.interrupt();
    this.#changed();
  }

  #submit(tabId: string, input: string, native: boolean): void {
    const tab = this.#current();
    if (!tab || tab.id !== tabId || this.#currentPrompt(tab.id)) return;
    if (native && input !== tab.draft.text) {
      // Native send may deliver before its last edit. Accept that only for a
      // previously-empty field, never a replay from the preceding submission.
      if (tab.draft.text !== "" || tab.lastSent === input) return;
    }
    const text = tab.gate.consume(tab.id, tab.draft.revision, input);
    if (!text) return;
    if (!tab.runner.enqueue(text)) {
      tab.gate.reset();
      tab.transcript.notice("Unable to queue prompt: agent session is unavailable or full.");
      this.#changed();
      return;
    }
    tab.transcript.submit(text);
    tab.lastSent = text;
    tab.draft.text = "";
    tab.draft.cursor = 0;
    tab.draft.undo = [];
    tab.draft.revision++;
    this.#changed();
  }

  #undo(tabId: string): void {
    const tab = this.#current();
    if (!tab || tab.id !== tabId) return;
    const previous = tab.draft.undo.pop();
    if (!previous) return;
    tab.draft.text = previous.text;
    tab.draft.cursor = previous.cursor;
    tab.draft.revision++;
    this.#changed();
  }

  #editNative(tabId: string, event: EditEvent): void {
    const tab = this.#current();
    if (!tab || tab.id !== tabId || this.#currentPrompt(tab.id)) return;
    const draft = tab.draft;
    if (
      !Number.isSafeInteger(event.from) ||
      !Number.isSafeInteger(event.to) ||
      event.from < 0 ||
      event.to < event.from ||
      event.to > draft.text.length
    ) {
      return;
    }
    this.#rememberDraft(draft);
    draft.text =
      draft.text.slice(0, event.from) + event.text + draft.text.slice(event.to);
    draft.cursor = Math.max(0, Math.min(draft.text.length, event.cursor));
    draft.revision++;
    this.#changed();
  }

  #rememberDraft(draft: Draft): void {
    draft.undo.push({ text: draft.text, cursor: draft.cursor });
    if (draft.undo.length > MAX_UNDO) draft.undo.shift();
  }

  #key(key: Key): "quit" | void {
    const tab = this.#current();
    if (!tab) return "quit";
    if (key.ctrl && key.name === "c") {
      if (this.#currentPrompt(tab.id)) {
        const prompt = this.#currentPrompt(tab.id);
        if (prompt) this.#finishPrompt(prompt, prompt.fallback);
      } else if (tab.transcript.busy) {
        this.#stop(tab.id);
      } else {
        return "quit";
      }
      return;
    }
    if (key.name === "escape") {
      const prompt = this.#currentPrompt(tab.id);
      if (prompt) this.#finishPrompt(prompt, prompt.fallback);
      else if (tab.draft.text) {
        this.#rememberDraft(tab.draft);
        tab.draft.text = "";
        tab.draft.cursor = 0;
        tab.draft.revision++;
        this.#changed();
      }
      return;
    }
    if (this.#currentPrompt(tab.id)) return;
    if (key.ctrl && key.name === "d" && !tab.draft.text) return "quit";
    if (key.ctrl && key.name === "n") {
      this.#addTab();
      return;
    }
    if (key.ctrl && key.name === "w") {
      void this.#closeActive();
      return;
    }
    if (key.ctrl && key.name === "tab") {
      const index = this.#tabs.indexOf(tab);
      this.#select(this.#tabs[(index + 1) % this.#tabs.length]?.id ?? tab.id);
      return;
    }
    if (key.ctrl && key.name === "z") {
      this.#undo(tab.id);
      return;
    }
    if (key.name === "enter" && !key.shift && !key.alt) {
      this.#submit(tab.id, tab.draft.text, false);
      return;
    }
    if (key.ctrl || key.meta) return;
    const draft = tab.draft;
    const text = draft.text;
    const cursor = draft.cursor;
    let next = text;
    let position = cursor;
    if (key.name === "backspace" && cursor > 0) {
      const prev = this.#step(text, cursor, -1);
      next = text.slice(0, prev) + text.slice(cursor);
      position = prev;
    } else if (key.name === "delete") {
      next = text.slice(0, cursor) + text.slice(this.#step(text, cursor, 1));
    } else if (key.name === "left") {
      position = this.#step(text, cursor, -1);
    } else if (key.name === "right") {
      position = this.#step(text, cursor, 1);
    } else if (key.name === "home") {
      position = 0;
    } else if (key.name === "end") {
      position = text.length;
    } else {
      const inserted = key.name === "enter" ? "\n" : key.text;
      if (inserted === undefined) return;
      next = text.slice(0, cursor) + inserted + text.slice(cursor);
      position = cursor + inserted.length;
    }
    if (next !== text) {
      this.#rememberDraft(draft);
      draft.revision++;
      draft.text = next;
    }
    draft.cursor = position;
    this.#changed();
  }

  #step(text: string, cursor: number, direction: -1 | 1): number {
    if (direction === 1) {
      return Math.min(text.length, cursor + ((text.codePointAt(cursor) ?? 0) > 0xffff ? 2 : 1));
    }
    const last = text.charCodeAt(cursor - 1);
    const first = text.charCodeAt(cursor - 2);
    return Math.max(
      0,
      cursor -
        (last >= 0xdc00 && last <= 0xdfff && first >= 0xd800 && first <= 0xdbff
          ? 2
          : 1),
    );
  }

  #event(event: TspEvent): "quit" | void {
    if (event.ev === "gone") return "quit";
    if (event.ev === "error") {
      this.#current()?.transcript.notice("TSP: " + event.msg);
      this.#changed();
    }
  }

  #changed(): void {
    if (this.#scheduled || this.#closed) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      if (!this.#closed) this.#render();
    });
  }

  #render(): void {
    const surface = this.#surface;
    const tab = this.#current();
    if (!surface || surface.closed || !tab) return;
    const id = tab.id;
    const epoch = this.#viewEpoch;
    const owns = () =>
      !this.#closed &&
      !surface.closed &&
      this.#viewEpoch === epoch &&
      this.#activeId === id &&
      this.#current() === tab;
    const interactiveId = id + "-" + String(epoch);
    const modal = this.#modal(id);
    surface.render(
      nativeView(
        {
          messages: tab.transcript.project(),
          model: this.config.defaultModel,
          tabs: this.#tabs.map((entry) => ({ id: entry.id, label: entry.label })),
          activeId: id,
          interactiveId,
          busy: tab.transcript.busy,
          steps: tab.transcript.steps,
          queued: tab.transcript.queued.length,
          draft: tab.draft.text,
          cursor: tab.draft.cursor,
          modal,
        },
        {
          switchTab: (nextId) => {
            if (owns()) this.#select(nextId);
          },
          newTab: () => {
            if (owns()) this.#addTab();
          },
          closeTab: () => {
            if (owns()) void this.#closeActive(tab);
          },
          stop: () => {
            if (owns()) this.#stop(id);
          },
          submit: () => {
            if (owns()) this.#submit(id, tab.draft.text, false);
          },
          edit: (event: EditEvent) => {
            if (owns()) this.#editNative(id, event);
          },
          send: (event: SendEvent) => {
            if (owns()) this.#submit(id, event.text, true);
          },
          undo: () => {
            if (owns()) this.#undo(id);
          },
        },
      ),
    );
    const focusId = modal?.answer
      ? "layers." + modal.id + ".answer-" + modal.id
      : "dock.composer-" + interactiveId;
    if (this.#focusedTab !== focusId) {
      surface.focus(focusId);
      this.#focusedTab = focusId;
    }
  }
}
