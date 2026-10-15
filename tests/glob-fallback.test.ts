import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFind } from "../src/core/tools/glob.js";

const posixTest = process.platform === "win32" ? test.skip : test;

describe("POSIX find fallback for glob", () => {
  posixTest("**/*.ts matches root and nested TypeScript files", async () => {
    const root = mkdtempSync(join(tmpdir(), "empryo-glob-"));
    try {
      mkdirSync(join(root, "src", "nested"), { recursive: true });
      writeFileSync(join(root, "root.ts"), "");
      writeFileSync(join(root, "src", "module.ts"), "");
      writeFileSync(join(root, "src", "nested", "deep.ts"), "");
      writeFileSync(join(root, "src", "nested", "notes.md"), "");

      const result = await runFind("**/*.ts", root);
      expect(result.success).toBe(true);
      const paths = result.output.split("\n");
      expect(paths).toContain(join(root, "root.ts"));
      expect(paths).toContain(join(root, "src", "module.ts"));
      expect(paths).toContain(join(root, "src", "nested", "deep.ts"));
      expect(paths).not.toContain(join(root, "src", "nested", "notes.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  posixTest("src/**/*.test.* matches tests at both shallow and deeper levels", async () => {
    const root = mkdtempSync(join(tmpdir(), "empryo-glob-"));
    try {
      mkdirSync(join(root, "src", "nested"), { recursive: true });
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "src", "component.test.ts"), "");
      writeFileSync(join(root, "src", "nested", "deep.test.ts"), "");
      writeFileSync(join(root, "src", "component.ts"), "");
      writeFileSync(join(root, "docs", "docs.test.ts"), "");

      const result = await runFind("src/**/*.test.*", root);
      expect(result.success).toBe(true);
      const paths = result.output.split("\n");
      expect(paths).toContain(join(root, "src", "component.test.ts"));
      expect(paths).toContain(join(root, "src", "nested", "deep.test.ts"));
      expect(paths).not.toContain(join(root, "docs", "docs.test.ts"));
      expect(paths).not.toContain(join(root, "src", "component.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
