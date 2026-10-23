/**
 * Opt-in TSP handshake. A missing terminal-side protocol leaves OpenTUI
 * untouched. The SDK owns tty mode, frame credits and clean disconnects.
 *
 * Source pattern: NousResearch/hermes-agent ui-tsp/src/entry.ts (MIT),
 * kvnloo/hermes-tern/frontend/src/entry.ts; SDK: @stencil-hq/tern 0.1.0.
 */
import { connect } from "@stencil-hq/tern";
import { loadConfig, loadProjectConfig, mergeConfigs } from "../../config/index.js";
import { getCwd } from "../../core/cwd.js";
import { CURRENT_VERSION } from "../../core/version.js";
import { NativeApp } from "./native-app.js";

export async function startNativeTern(): Promise<boolean> {
  const config = mergeConfigs(loadConfig(), loadProjectConfig(getCwd()));
  // Keep OpenTUI's first-run setup instead of starting an embedded agent
  // that would exit the process without a configured model.
  if (!config.defaultModel || config.defaultModel === "none") return false;

  const session = await connect({
    app: "empryo",
    version: CURRENT_VERSION,
    features: ["edit", "undo", "send"],
  });
  if (!session) return false;

  await new NativeApp(session, config).run();
  return true;
}
