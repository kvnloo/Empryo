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
  // CLI resume/wizard/plugin intent belongs to OpenTUI until native supports it.
  if (process.argv.slice(2).length > 0) return false;
  const { shouldRunAddonWizard } = await import("../../core/setup/addon-wizard.js");
  if (shouldRunAddonWizard()) return false;
  const config = mergeConfigs(loadConfig(), loadProjectConfig(getCwd()));
  // Keep OpenTUI's first-run setup instead of starting an embedded agent
  // that would exit the process without a configured model.
  if (!config.defaultModel || config.defaultModel === "none") return false;

  let session;
  try {
    session = await connect({
      app: "empryo",
      version: CURRENT_VERSION,
      features: ["edit", "undo", "send"],
    });
  } catch {
    return false;
  }
  if (!session) return false;

  await new NativeApp(session, config).run();
  return true;
}
