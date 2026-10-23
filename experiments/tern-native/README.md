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

## TRN2 correctness pass: operator validation required

The native SDK composer, send, stop, close and tab controls now have per-tab
node identities and execution-time tab-instance/epoch guards. Hidden
background approvals are denied; active-tab prompts form a LIFO modal queue
with once-only settlement, including usable free-text question answers.
Plan reviews present the actual plan file, content and steps.

Headless tool-result events keep the legacy 200-character `summary` for
old JSONL clients while also delivering typed `success`, `error`, and
untruncated `output`. The live native projection displays real failures as
errors and keeps the full output. Real core subagent lifecycle, step and
stats emitters are correlated to the engine's current tool-call ID, projected
under the parent tool, and unsubscribed at turn completion. Native engine
setup rejects instead of exiting the host process; unrecoverable errors
retire active/queued turns and fail closed. `--resume`, `--session`,
`--wizard`, `--presets`, `--plugin` and all other CLI arguments deliberately
use the existing OpenTUI boot path; unsupported native resume/history import
is **not** claimed.

The changes are **not locally executed** in the connector-only worker.
Previous adapter-only CI does not cover them. OMP must validate the new head:

```sh
git fetch origin feat/tern-native-preview-port-20261016
git switch feat/tern-native-preview-port-20261016
git pull --ff-only
git rev-parse HEAD
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test tests/tern-native.test.ts tests/tern-native-runtime.test.ts tests/tern-native-correctness.test.ts
bun test
```

Operator native and fallback checks (configured provider, terminal with TSP):

```sh
SOULFORGE_TERN=1 TERN_TSP_RECORD=/tmp/empryo-tsp.jsonl bun run dev
SOULFORGE_TERN=1 TERN_TSP=0 bun run dev
SOULFORGE_TERN=1 bun run dev --resume EXISTING_SESSION_ID
```

Replay `/tmp/empryo-tsp.jsonl` with the Tern SDK's `surface-play` tool
after capturing a live TSP recording. Exercise frame-credit starvation,
disconnect, multi-tab stale input, overlapping approvals and session reload.
The repository does not yet contain a credential-free real-provider loopback
smoke harness or automated recording/replay gate. The new SDK Session tests
use a memory-backed transport, **not** a live native terminal.

Known baseline issue: the pre-TRN1 full suite previously had six Git
5000-ms timeouts in `cross-tab-battle.test.ts` (lines 1445, 1461, 1474,
1517, 1931) and `git-status-parsing.test.ts` (line 311). Do not hide or
weaken those assertions. Distinguish any still-failing legacy tests from
new Tern failures.

Outstanding work: offline loopback-provider entry smoke, TSP recording/replay
and credit starvation in an actual supported host; native saved-session
history/picker; real terminal editor/media/diff parity. OpenTUI remains
the complete fallback. Public v3 integration remains contingent on a
published, maintainer-approved extension seam. Preserve the original Hermes /
Nous Research and Stencil/Tern MIT provenance and this project's BUSL-1.1.
