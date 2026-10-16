/**
 * Tern native callback ownership and atomic send guards.
 * Port of the protections from Hermes' latest TSP preview (MIT):
 * https://github.com/kvnloo/hermes-agent/blob/ba430cf6cb567122134a6daa61a227a9c33e36c7/ui-tsp/src/app.ts
 */

/** Every opening has a distinct ID; only the top, still-open instance may act. */
export class OverlayOwners {
  #serial = 0;
  #stack: Array<{ key: string; id: string }> = [];

  open(key: string): string {
    this.#stack = this.#stack.filter((item) => item.key !== key);
    const id = `layer.${key}:${++this.#serial}`;
    this.#stack.push({ key, id });
    return id;
  }

  close(id: string): void {
    this.#stack = this.#stack.filter((item) => item.id !== id);
  }

  isTop(id: string): boolean {
    return this.#stack.at(-1)?.id === id;
  }

  /** Check ownership again when a queued TSP callback actually executes. */
  guard(id: string, handler: () => void): () => void {
    return () => {
      if (this.isTop(id)) handler();
    };
  }

  clear(): void {
    this.#stack = [];
  }
}

/**
 * Enter and native 'send' must consume the same draft at most once.
 * Revision increments when the user changes/consumes the draft; subsequent
 * intentional sends with identical text and a new revision still work.
 */
export class SubmissionGate {
  #used = new Set<string>();

  consume(sessionId: string | null, draftRevision: number, text: string): string | null {
    if (!sessionId || !text.trim()) return null;
    const key = `${sessionId}:${draftRevision}`;
    if (this.#used.has(key)) return null;
    this.#used.add(key);
    // Bound memory for long sessions; only revisions of still-live drafts matter.
    if (this.#used.size > 256) {
      const oldest = this.#used.values().next().value;
      if (oldest !== undefined) this.#used.delete(oldest);
    }
    return text;
  }

  reset(): void {
    this.#used.clear();
  }
}
