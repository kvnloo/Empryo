/**
 * Empryo's TSP view: Hermes/Nous Research's native omp.* roles, rendered
 * through Stencil's SDK instead of painting OpenTUI cells.
 *
 * Tern owns node reconciliation, native events and frame credits.
 */
import { node, type EditEvent, type Node, type SendEvent } from "@stencil-hq/tern";
import type { NativeNode } from "./projection.js";

export interface ViewChoice {
  id: string;
  label: string;
  tone: "accent" | "neutral" | "error";
  activate: () => void;
}

export interface ViewModal {
  id: string;
  title: string;
  description: string;
  choices: readonly ViewChoice[];
}

export interface NativeViewState {
  messages: readonly NativeNode[];
  model: string;
  tabs: readonly { id: string; label: string }[];
  activeId: string;
  busy: boolean;
  steps: number;
  queued: number;
  draft: string;
  cursor: number;
  modal: ViewModal | null;
}

export interface NativeViewActions {
  switchTab: (tabId: string) => void;
  newTab: () => void;
  closeTab: () => void;
  stop: () => void;
  submit: () => void;
  edit: (event: EditEvent) => void;
  send: (event: SendEvent) => void;
  undo: () => void;
}

export function toTernNode(input: NativeNode): Node {
  return node(
    input.k,
    { ...input.p, key: input.id },
    (input.c ?? []).map(toTernNode),
  );
}

export function nativeView(state: NativeViewState, actions: NativeViewActions) {
  const messages = state.messages.map(toTernNode);
  const main = node(
    "col",
    { key: "transcript", role: "omp.session", gap: "sm" },
    messages.length
      ? messages
      : [
          node("card", { key: "welcome", head: "Empryo", role: "omp.welcome" }, [
            node("md", { key: "intro" }, "Native Tern session. Type a prompt to begin."),
          ]),
        ],
  );

  const tabs = state.tabs.map((tab) =>
    node(
      "text",
      {
        key: "tab-" + tab.id,
        role: "omp.tab",
        tone: tab.id === state.activeId ? "accent" : "muted",
        onClick: () => actions.switchTab(tab.id),
      },
      tab.label,
    ),
  );
  const status = state.busy
    ? "Working" + (state.steps ? " · step " + String(state.steps) : "")
    : "Ready";
  const dock = node("col", { key: "dock", role: "omp.dock", gap: "xs" }, [
    node("row", { key: "tabs", role: "omp.tabs", gap: "sm" }, [
      ...tabs,
      node("text", { key: "new", onClick: actions.newTab, tone: "accent" }, "+"),
      node("text", { key: "close", onClick: actions.closeTab, tone: "muted" }, "×"),
    ]),
    node("editor", {
      key: "composer",
      role: "omp.editor",
      text: state.draft,
      cursor: state.cursor,
      placeholder: "Message Empryo",
      prompt: "> ",
      maxLines: 12,
      onEdit: actions.edit,
      onSend: actions.send,
      onUndo: actions.undo,
    }),
    node("status", { key: "status", role: "omp.status" }, [
      node("seg", { key: "working", text: status }),
      node("seg", { key: "model", text: state.model, side: "right" }),
      node("seg", {
        key: "queue",
        text: state.queued ? String(state.queued) + " queued" : "Enter send · Ctrl+N tab",
      }),
      node(
        "seg",
        { key: "action", side: "right", onClick: state.busy ? actions.stop : actions.submit },
        state.busy ? "Stop (Ctrl+C)" : "Send",
      ),
    ]),
  ]);

  const modal = state.modal;
  const layer = node(
    "col",
    { key: "layers" },
    modal
      ? [
          node(
            "overlay",
            {
              key: modal.id,
              role: "omp.modal",
              head: modal.title,
              modal: true,
              anchor: "center",
              size: "md",
            },
            [
              node("md", { key: "question" }, modal.description),
              node(
                "row",
                { key: "choices", gap: "md" },
                modal.choices.map((choice) =>
                  node(
                    "text",
                    {
                      key: choice.id,
                      role: "omp.modal.action",
                      tone: choice.tone,
                      onClick: choice.activate,
                    },
                    choice.label,
                  ),
                ),
              ),
            ],
          ),
        ]
      : [],
  );

  return { main, dock, layer };
}
