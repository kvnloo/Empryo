import { describe, expect, it } from "bun:test";
import { run } from "../src/core/git/status.js";

describe("git subprocess stderr backpressure", () => {
  it("drains a Git alias writing more than the stderr pipe capacity", async () => {
    if (process.platform === "win32") return; // POSIX Git shell alias syntax.
    // The repo requires Bun; Git runs this alias using its normal ! shell path.
    // A piped-but-unread stderr blocks before 1 MiB and then times out.
    const alias = "!bun -e 'process.stderr.write(\"x\".repeat(1048576))'";
    const result = await run(["-c", "alias.stderrflood=" + alias, "stderrflood"], process.cwd(), 1200);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("");
  });
});
