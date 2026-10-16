# Feature request: opt-in native Tern support via TSP

I'd like Empryo's terminal UI to support [Tern](https://docs.stencil.so/tern/protocol/index.html) natively, using semantic TSP nodes for chat, thinking, tool/subagent progress, composer and approvals, rather than only ANSI/PTY cell rendering.

We've already developed this integration in [Hermes' Tern preview at `ba430cf6`](https://github.com/kvnloo/hermes-agent/tree/ba430cf6cb567122134a6daa61a227a9c33e36c7/ui-tsp). It includes TSP handshake + Ink fallback, semantic tool cards, the session-switch guard, native send, stale-overlay protection and tests. The [Tern TypeScript SDK](https://github.com/stencil-hq/tern-sdk) is MIT-licensed.

I've staged [a pinned source snapshot and initial Empryo-specific projections/guards in my fork](https://github.com/kvnloo/Empryo/tree/feat/tern-native-preview-port-20261016). The source archive is **not yet a working Empryo frontend**.

**Proposed approach:** opt-in native rendering when TSP is available; retain OpenTUI fallback elsewhere; let Empryo own sessions, prompts, permissions and dispatch. Test normal turns, stale actions, cancellation, tool/subagent progress, and fallback.

Empryo v3's current UI is private, so I'd appreciate guidance on the preferred integration point before sending a code PR. Happy to adapt the prototype to that surface.

Credit to the Hermes/Nous Research and Tern/Stencil maintainers and all authors of the preview. Original MIT provenance and license notices are preserved in the fork.
