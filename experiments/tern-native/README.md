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
TRN3 now adds an isolated local provider fixture, SDK-level protocol tests,
a JSONL wire record/credit regression, and a separate real OS-PTY entry smoke.
These are **not yet executed** by this connector-only worker; the historical
TRN2 SDK tests used a memory-backed transport. See the commands below.

Known baseline issue: the pre-TRN1 full suite previously had six Git
5000-ms timeouts in `cross-tab-battle.test.ts` (lines 1445, 1461, 1474,
1517, 1931) and `git-status-parsing.test.ts` (line 311). Do not hide or
weaken those assertions. Distinguish any still-failing legacy tests from
new Tern failures.

Outstanding product features beyond this acceptance slice: native saved-session
history/picker and real terminal editor/media/diff parity. The new loopback/PTY
harness must first be run by OMP, including the real Tern-serve acceptance. OpenTUI remains
the complete fallback. Public v3 integration remains contingent on a
published, maintainer-approved extension seam. Preserve the original Hermes /
Nous Research and Stencil/Tern MIT provenance and this project's BUSL-1.1.


## TRN3 acceptance harness (fork-only; never use a paid model)

The isolated fixture at `experiments/tern-native/loopback-provider.ts` is a
**synthetic** OpenAI-compatible Ollama endpoint, bound to `127.0.0.1` only.
It returns SSE text deltas or a model-generated `read` tool call for an
operator-owned `fixture.txt`; the real Empryo agent executes that read.
Its `SYNTHETIC_*` markers are test data, not assertions about model quality.
The POSIX script `experiments/tern-native/pty-smoke.py` starts a private
HOME and workspace, serves the fixture at a free loopback port, launches
`src/boot.tsx` under a **real OS PTY**, implements the actual hello/ACK
terminal end of the SDK wire, and feeds separate UTF-8 byte writes,
bracketed paste, and Enter. It verifies the exact prompt in the HTTP
provider log, streamed answer frames, a real `read` result on the owned
file, recorded in/out TSP frames, terminal `gone` teardown/mode reset,
and a fresh `TERN_TSP=0` **actual OpenTUI boot**. It does not call a fake
agent runner. This PTY terminal fixture is not a substitute for OMP's
owned headless Sway + Tern serve run.

`tests/tern-native-e2e.test.ts` calls the real Tern SDK `connect()`, the
real `Session` and `Surface` over deterministic byte-stream endpoints
(not mocked SDK objects), including handshake refusal/timeout/non-TTY,
1-credit starvation and coalescing, recorded JSONL/readback, native
edit/undo/send and guarded modal actions, and terminal-`gone` cleanup.
Its controller-action test injects only a probe `RunChat` to assert
routing; the **separate PTY program** is the real model-adapter proof.
Actual SDK recording is at the optional `TERN_TSP_RECORD` path.
A frame replay invariant checks the exact final diff, focus operation,
and omission of superseded drafts after the ACK.

### Exact OMP verification commands

From the existing downstream branch of PR #5 (no new PR, no merge):

```sh
git fetch origin feat/tern-native-preview-port-20261016
git switch feat/tern-native-preview-port-20261016
git pull --ff-only
git rev-parse HEAD
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test tests/tern-native.test.ts tests/tern-native-runtime.test.ts tests/tern-native-correctness.test.ts tests/tern-native-e2e.test.ts tests/git-stderr-drain.test.ts
bun test
bun run build:no-compiler
python3 experiments/tern-native/pty-smoke.py
```

Run the Python PTY harness on Linux/macOS after frozen install. It requires
`bun` and Python 3's **standard library**, no API keys, no Ollama process
and no external provider. It creates and deletes its own temporary HOME,
config and workspace; it should print two `PASS` lines on success.
It deliberately **fails** if the real tool result, exact PTY prompt,
protocol capture, terminal cleanup, or classic fallback is absent.

For a separate visual acceptance inside an **owned headless Sway + Tern serve**
environment, start the loopback endpoint in one operator terminal:

```sh
TRN3_PORT=11439 bun run experiments/tern-native/loopback-provider.ts
```

In the Tern pane use an isolated HOME and workspace so no credentials or
project files are touched (preserve the repo path before changing cwd):

```sh
EMPRYO_ROOT="$PWD"
TRN3_ROOT="$(mktemp -d)"
mkdir -p "$TRN3_ROOT/home/.soulforge" "$TRN3_ROOT/workspace"
printf '%s\n' '{"defaultModel":"ollama/trn3-fixture","addonsPromptShown":true,"repoMap":false,"webSearch":false,"telemetry":false}' > "$TRN3_ROOT/home/.soulforge/config.json"
printf 'TRN3_OWNED_CONTENT\n' > "$TRN3_ROOT/workspace/fixture.txt"
cd "$TRN3_ROOT/workspace"
HOME="$TRN3_ROOT/home" SOULFORGE_TERN=1 SOULFORGE_NO_PROMPT=1 SOULFORGE_NO_REPOMAP=1 OLLAMA_HOST=http://127.0.0.1:11439 TERN_TSP_RECORD="$TRN3_ROOT/tsp.jsonl" bun run "$EMPRYO_ROOT/src/boot.tsx"
```

Send `TRN3_READ_FILE` and inspect the live streamed transcript/tool result.
Then run the same entry with `TERN_TSP=0` to verify the original OpenTUI
renderer. Always stop the fixture server afterward and remove the temporary
directory. Preserve any recorded evidence for review before cleanup.

### Pre-existing full-suite Git timeouts

Before this slice, plain `bun test` gave 3099 pass, 1 skip, 6 timeout
failures (five `tests/cross-tab-battle.test.ts` and one
`tests/git-status-parsing.test.ts`). Inspection showed
`src/core/git/status.ts` spawned with a piped stderr but never consumed it.
That can deadlock Git when stderr exceeds the pipe capacity. TRN3 now drains
stderr and adds `tests/git-stderr-drain.test.ts` with a real Git alias
writing 1 MiB to stderr. **It has not been established that this explains
all six historical timeouts.** Rerun the original full suite without skips
or larger timeouts; record any exact survivors and distinguish environment
contention from that pipe bug. Lint checks `src/` (per package.json);
the new test utilities are exercised by their explicit Bun commands.

**Not verified by this worker:** install, lint, typecheck, focused tests,
full tests, supported build, real OS-PTY execution and Sway/Tern serve.
Nothing may be described as green at this new head until OMP runs it.
