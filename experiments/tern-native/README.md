# Empryo × Tern native UI — downstream preview

**Status:** opt-in native TSP frontend on the **public SoulForge v2** runtime, with a handshake fallback to OpenTUI. The Empryo v3 UI is private and is **not** integrated. The archived Hermes preview remains a porting workbench. No upstream PR is proposed before maintainer agreement.

## Source and credit
- Source: [Hermes Tern preview `ba430cf6cb567122134a6daa61a227a9c33e36c7`](https://github.com/kvnloo/hermes-agent/tree/ba430cf6cb567122134a6daa61a227a9c33e36c7/ui-tsp).
- The `hermes-preview/` subdirectory contains verbatim selected source files from that pinned revision for porting reference; **they are not Empryo code** and cannot run independently.
- Reference tests retain their original bytes under `*.test.ts.txt`, so Bun does not discover the incomplete Hermes snapshot as Empryo's own suite. The actual adapter regressions are in `tests/tern-native.test.ts`; no Hermes gateway or Tern dependency is added just to run archived fixtures.
- Source license: [NousResearch/hermes-agent MIT](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE) © 2025 Nous Research; keep the copyright and license with any reused source.
- Protocol/SDK: [Stencil Tern Surface Protocol](https://docs.stencil.so/tern/protocol/index.html), [stencil-hq/tern-sdk](https://github.com/stencil-hq/tern-sdk), MIT. Credit all original contributors; do not present this archive as our original work.

## Port surface (keep Empryo as authority)
1. Empryo's current [OpenTUI App](../../src/components/App.tsx), [message model](../../src/types/index.ts) and dispatch events stay authoritative.
2. Add a versioned, opt-in `@stencil-hq/tern` / TSP frontend that maps **Empryo** message segments, tool results, subagent progress and approvals to native nodes. Keep stable identities across streaming changes.
3. Reuse the Hermes preview's session-switch generations, renderer/coalescing design, native send path, and late-overlay-action guard. Do **not** import Hermes JSON-RPC gateway or replace Empryo's runtime.
4. On missing TSP handshake, run the existing OpenTUI renderer. Preserve normal terminal behavior and all existing permission boundaries.
5. Compare against Tern's `TERN_TSP_RECORD` traces and test normal turn, tool/subagent, input, cancellation, stale callbacks, theme switching, and non-Tern fallback.

## Validation and upstream boundary

The fork CI keeps the existing full-source lint and typecheck gates and runs the actual Empryo adapter tests with pinned Bun 1.3.13:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test tests/tern-native.test.ts
```

These checks validate only the renderer-neutral projection and guards, not a TSP handshake, live controller, private-v3 integration, recording/replay or OpenTUI fallback. Do not call a green check a working frontend.

The architecture proposal is published in [upstream Ideas Discussion #243](https://github.com/proxysoul/Empryo/discussions/243), following CONTRIBUTING. Maintainer guidance on a v3 integration point is still required before an implementation PR. The source draft in `UPSTREAM_ISSUE.md` remains historical; the earlier connector403 is not the current publication status.


## Native frontend on the public v2 runtime

The opt-in boot seam in src/boot.tsx dynamically loads
src/components/tern/native-entry.ts. The Stencil SDK negotiates with the
terminal before OpenTUI's splash or renderer. An absent TSP handshake
returns to the existing OpenTUI path. Leave SOULFORGE_TERN unset to
force the classic interface.

native-app.ts owns the TSP surface, composer, tab views, queued prompts
and fail-closed approval overlays. native-runner.ts calls Empryo's own
headless/run.ts runChat to preserve its providers, tools, safety hooks
and session persistence. Native UI elements are projected by
native-transcript.ts and native-view.ts from typed HeadlessEvents.
Hermes' omp.* semantic roles and stable IDs are reused, not its backend.
Tern handles native events, diffing and credit control.

In a terminal with TSP support, after configuring a default provider:

    bun install --frozen-lockfile
    SOULFORGE_TERN=1 TERN_TSP_RECORD=/tmp/empryo-tsp.jsonl bun run dev

To verify an intentional missing-protocol fallback:

    SOULFORGE_TERN=1 TERN_TSP=0 bun run dev

Enter sends, Shift+Enter inserts a newline, Ctrl+C interrupts,
Ctrl+N adds a tab, Ctrl+Tab switches tabs, Ctrl+W closes a tab,
and Ctrl+D on an empty composer exits. Native edit/send/undo
and keyboard input share one guarded draft. Late overlays or
wrong-tab callbacks cannot approve operations; cancelling and
closing deny unresolved permissions.

Boundary: the public headless event stream currently lacks rich live
subagent trees, full diff/media payloads and terminal editor handoff.
These are subsequent native-parity slices, not features claimed here.
OpenTUI remains the complete fallback. Empryo v3 integration still
requires a published maintainer extension point.
