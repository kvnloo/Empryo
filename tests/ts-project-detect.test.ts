import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetNudgeState, isTsJsProject } from "../src/core/tools/ts-project-detect.js";

const roots: string[] = [];

afterEach(() => {
  __resetNudgeState();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function makeWorkspaces(): { ts: string; other: string } {
  const root = mkdtempSync(join(tmpdir(), "soulforge-ts-detect-"));
  roots.push(root);
  const ts = join(root, "typescript");
  const other = join(root, "python");
  mkdirSync(ts);
  mkdirSync(other);
  writeFileSync(join(ts, "package.json"), "{}");
  writeFileSync(join(other, "pyproject.toml"), "");
  return { ts, other };
}

describe("isTsJsProject cache isolation", () => {
  test("does not share a positive result with another workspace", async () => {
    const { ts, other } = makeWorkspaces();
    expect(await isTsJsProject(ts)).toBe(true);
    expect(await isTsJsProject(other)).toBe(false);
    expect(await isTsJsProject(ts)).toBe(true);
  });

  test("does not share a negative result with another workspace", async () => {
    const { ts, other } = makeWorkspaces();
    expect(await isTsJsProject(other)).toBe(false);
    expect(await isTsJsProject(ts)).toBe(true);
    expect(await isTsJsProject(other)).toBe(false);
  });

  test("normalizes equivalent workspace paths to the same cache key", async () => {
    const { ts } = makeWorkspaces();
    expect(await isTsJsProject(join(ts, "."))).toBe(true);
    expect(await isTsJsProject(ts)).toBe(true);
  });

  test("reset invalidates cached classifications", async () => {
    const { other } = makeWorkspaces();
    expect(await isTsJsProject(other)).toBe(false);
    writeFileSync(join(other, "tsconfig.json"), "{}");
    expect(await isTsJsProject(other)).toBe(false);
    __resetNudgeState();
    expect(await isTsJsProject(other)).toBe(true);
  });
});
