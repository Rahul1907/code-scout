import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCleanup } from "./cleanup.js";

describe("Worker Maintenance Cleanup", () => {
  it("deletes worktrees older than specified threshold", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codescout-cleanup-test-"));
    const repoDir = path.join(tempDir, "repo-123", "runs");
    fs.mkdirSync(repoDir, { recursive: true });

    const staleRunDir = path.join(repoDir, "stale-run-456");
    const freshRunDir = path.join(repoDir, "fresh-run-789");

    fs.mkdirSync(staleRunDir, { recursive: true });
    fs.mkdirSync(freshRunDir, { recursive: true });
    fs.writeFileSync(path.join(staleRunDir, "code.txt"), "hello");
    fs.writeFileSync(path.join(freshRunDir, "code.txt"), "world");

    // Make staleRunDir 48 hours old
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(staleRunDir, twoDaysAgo, twoDaysAgo);

    const result = await runCleanup({
      reposBaseDir: tempDir,
      maxWorktreeAgeHours: 24,
      maxInactiveDays: 14,
    });

    expect(result.worktreesDeleted).toBe(1);
    expect(fs.existsSync(staleRunDir)).toBe(false);
    expect(fs.existsSync(freshRunDir)).toBe(true);

    // Cleanup test temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

