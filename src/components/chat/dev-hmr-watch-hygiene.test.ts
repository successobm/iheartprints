import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Phase 1.7 live UX: Fast Refresh flashing during cleanup acceptance was
 * caused by source writes under src/ (the agent implementing Magic Select)
 * while next dev watched them — not by a self-writing watcher loop, not by
 * two next processes, and not by GuidedCleanupWorkspace identity.
 *
 * These pins keep generated/local artifacts out of the watched import graph
 * and keep the prepared <img> keyed by preparedRevision only.
 */
describe("dev HMR watch hygiene", () => {
  const gitignore = readFileSync(".gitignore", "utf8");
  const workspaceSource = readFileSync(
    "src/components/chat/GuidedCleanupWorkspace.tsx",
    "utf8",
  );

  it("gitignores local-acceptance so generated bowling artifacts are not source", () => {
    assert.match(gitignore, /^\.local-acceptance\//m);
  });

  it("gitignores sprint persistence and does not watch remote schema dumps as source", () => {
    assert.match(gitignore, /^\.data\//m);
    assert.doesNotMatch(
      readFileSync("src/components/chat/GuidedCleanupWorkspace.tsx", "utf8"),
      /remote_public_schema/,
    );
  });

  it("workspace img identity is preparedRevision — not Date.now or a random key", () => {
    assert.match(workspaceSource, /key=\{preparedRevision\}/);
    assert.doesNotMatch(workspaceSource, /key=\{Date\.now/);
    assert.doesNotMatch(workspaceSource, /key=\{.*random/);
    assert.doesNotMatch(workspaceSource, /key=\{.*Math\.random/);
  });

  it("workspace never imports .local-acceptance (would put it on the HMR graph)", () => {
    assert.doesNotMatch(workspaceSource, /\.local-acceptance/);
  });
});
