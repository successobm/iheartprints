import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";

import { generateBuildInfo, GIT_SHA_PATTERN } from "./generate-build-info.mjs";

const VALID_SHA_A = "7fbe2d295a3ded1313e4e6711bb7e1f7f765a8e8";
const VALID_SHA_B = "856f9be00000000000000000000000000000000a";

describe("generate-build-info (Cursor repair: stale SHA + destructive overwrite)", () => {
  let tempDir = "";

  before(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-build-info-"));
  });

  function freshEnvFilePath() {
    return path.join(tempDir, `${Date.now()}-${Math.random()}.env`);
  }

  it("writes a fresh file with GIT_SHA when none existed before", () => {
    const target = freshEnvFilePath();
    const result = generateBuildInfo({
      envFilePath: target,
      resolveGitSha: () => VALID_SHA_A,
    });

    assert.deepEqual(result, { ok: true, gitSha: VALID_SHA_A });
    assert.equal(readFileSync(target, "utf8"), `GIT_SHA=${VALID_SHA_A}\n`);
  });

  it("replaces a previous GIT_SHA on a normal rerun (no duplicate lines)", () => {
    const target = freshEnvFilePath();
    generateBuildInfo({ envFilePath: target, resolveGitSha: () => VALID_SHA_A });
    const result = generateBuildInfo({
      envFilePath: target,
      resolveGitSha: () => VALID_SHA_B,
    });

    assert.deepEqual(result, { ok: true, gitSha: VALID_SHA_B });
    const lines = readFileSync(target, "utf8").split(/\r?\n/).filter(Boolean);
    assert.deepEqual(lines, [`GIT_SHA=${VALID_SHA_B}`]);
  });

  it("preserves unrelated existing lines instead of truncating the file (Cursor finding 2: destructive overwrite)", () => {
    const target = freshEnvFilePath();
    writeFileSync(
      target,
      "SOME_UNRELATED_VAR=keep-me\nANOTHER_VAR=also-keep-me\n",
      "utf8",
    );

    const result = generateBuildInfo({
      envFilePath: target,
      resolveGitSha: () => VALID_SHA_A,
    });

    assert.deepEqual(result, { ok: true, gitSha: VALID_SHA_A });
    const lines = readFileSync(target, "utf8").split(/\r?\n/).filter(Boolean);
    assert.deepEqual(lines.sort(), [
      "ANOTHER_VAR=also-keep-me",
      `GIT_SHA=${VALID_SHA_A}`,
      "SOME_UNRELATED_VAR=keep-me",
    ]);
  });

  it("never publishes a stale SHA when the current run fails to resolve one (Cursor finding 1: stale SHA publication)", () => {
    const target = freshEnvFilePath();
    // Simulate a previous SUCCESSFUL build that published a real SHA.
    generateBuildInfo({ envFilePath: target, resolveGitSha: () => VALID_SHA_A });
    assert.ok(readFileSync(target, "utf8").includes(VALID_SHA_A));

    // This run's git resolution fails (e.g. shallow clone, no .git, git
    // binary missing). The OLD GIT_SHA=<VALID_SHA_A> must not survive.
    const result = generateBuildInfo({
      envFilePath: target,
      resolveGitSha: () => {
        throw new Error("git rev-parse HEAD failed: not a git repository");
      },
    });

    assert.deepEqual(result, { ok: false, gitSha: null });
    const contents = existsSync(target) ? readFileSync(target, "utf8") : "";
    assert.ok(
      !contents.includes(VALID_SHA_A),
      "stale GIT_SHA from the previous successful build must not survive a failed run",
    );
    assert.ok(!contents.includes("GIT_SHA="));
  });

  it("preserves unrelated lines even when the current run fails and clears a stale SHA", () => {
    const target = freshEnvFilePath();
    writeFileSync(
      target,
      `SOME_UNRELATED_VAR=keep-me\nGIT_SHA=${VALID_SHA_A}\n`,
      "utf8",
    );

    const result = generateBuildInfo({
      envFilePath: target,
      resolveGitSha: () => {
        throw new Error("git unavailable");
      },
    });

    assert.deepEqual(result, { ok: false, gitSha: null });
    const contents = readFileSync(target, "utf8");
    assert.ok(contents.includes("SOME_UNRELATED_VAR=keep-me"));
    assert.ok(!contents.includes("GIT_SHA="));
  });

  it("deletes the file entirely once it has nothing left to record", () => {
    const target = freshEnvFilePath();
    writeFileSync(target, `GIT_SHA=${VALID_SHA_A}\n`, "utf8");

    generateBuildInfo({
      envFilePath: target,
      resolveGitSha: () => {
        throw new Error("git unavailable");
      },
    });

    assert.ok(!existsSync(target));
  });

  it("treats a malformed resolver result (not a 40-char hex SHA) as failure, not as a value to publish", () => {
    const target = freshEnvFilePath();
    generateBuildInfo({ envFilePath: target, resolveGitSha: () => VALID_SHA_A });

    for (const malformed of ["short-sha", "7fbe2d2", "", "   ", null, undefined]) {
      const result = generateBuildInfo({
        envFilePath: target,
        resolveGitSha: () => malformed,
      });
      assert.deepEqual(result, { ok: false, gitSha: null });
      const contents = existsSync(target) ? readFileSync(target, "utf8") : "";
      assert.ok(!contents.includes(VALID_SHA_A));
    }
  });

  it("GIT_SHA_PATTERN matches only a full 40-character lowercase hex SHA", () => {
    assert.ok(GIT_SHA_PATTERN.test(VALID_SHA_A));
    assert.ok(!GIT_SHA_PATTERN.test(VALID_SHA_A.toUpperCase()));
    assert.ok(!GIT_SHA_PATTERN.test(VALID_SHA_A.slice(0, 7)));
    assert.ok(!GIT_SHA_PATTERN.test(`${VALID_SHA_A}0`));
  });
});
