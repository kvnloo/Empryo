/**
 * Native Tern session ownership rules, adapted from the Hermes TSP preview
 * (Nous Research/hermes-agent ui-tsp/src/flow.ts, MIT).
 * Source: https://github.com/kvnloo/hermes-agent/blob/ba430cf6cb567122134a6daa61a227a9c33e36c7/ui-tsp/src/flow.ts
 */
export type RequestRoute = "show" | "hold" | "drop";

export interface Busy {
  startedAt: number;
  label: string;
  since: object;
}

/** Only the newest asynchronous session selection may become active. */
export class Switches {
  #generation = 0;
  #pending = false;

  get pending(): boolean {
    return this.#pending;
  }

  begin(): number {
    this.#pending = true;
    return ++this.#generation;
  }

  current(token: number): boolean {
    return token === this.#generation;
  }

  end(token: number): void {
    if (this.current(token)) this.#pending = false;
  }

  route(active: string | null, sessionId: string | undefined): RequestRoute {
    if (!sessionId || !active || sessionId === active) return "show";
    return this.#pending ? "hold" : "drop";
  }
}

/** Only render events for the active session, except explicitly global events. */
export function ownsEvent(
  active: string | null,
  ev: { type: string; session_id?: string },
): boolean {
  return !ev.session_id || !active || ev.session_id === active || ev.type.startsWith("gateway.");
}

/** A resumed running or waiting turn retains its original start time. */
export function busyFrom(
  result: { running?: boolean; status?: string; turn_started_at?: number | null },
  now = Date.now(),
): Busy | null {
  if (!result.running && result.status !== "working" && result.status !== "waiting") {
    return null;
  }
  return {
    label: "Working…",
    since: {},
    startedAt: result.turn_started_at ? result.turn_started_at * 1_000 : now,
  };
}
