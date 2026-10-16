# Empryo × Tern native UI — downstream preview

**Status:** porting workbench only; not integrated with Empryo v3 and **not a working Empryo frontend**. The current Empryo v3 UI is private, and Empryo's public `main` is SoulForge v2. No upstream PR is proposed before maintainer agreement.

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
