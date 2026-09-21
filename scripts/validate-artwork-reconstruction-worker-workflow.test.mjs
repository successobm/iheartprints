import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Structural assertions on the committed artwork-reconstruction RECOVERY
 * workflow. Plain-text/regex checks on the raw file, mirroring
 * validate-final-artwork-worker-workflow.test.mjs. Never makes an HTTP
 * request.
 */
const path = ".github/workflows/artwork-reconstruction-worker.yml";

describe("artwork-reconstruction-worker.yml", () => {
  it("is present", () => {
    assert.ok(existsSync(path));
  });

  const source = existsSync(path) ? readFileSync(path, "utf8") : "";
  // Executable lines only, so header comments can't satisfy or trip checks.
  const code = source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  it("runs on a five-minute recovery schedule", () => {
    assert.match(code, /\n\s*schedule:\s*\n\s*-\s*cron:\s*"\*\/5 \* \* \* \*"/);
    assert.equal((code.match(/cron:/g) ?? []).length, 1);
  });

  it("targets exactly /api/worker/artwork-reconstruction on the production app", () => {
    const urls = code.match(/https:\/\/[^\s"']+/g) ?? [];
    assert.deepEqual(urls, [
      "https://iheartprints-88sjr.ondigitalocean.app/api/worker/artwork-reconstruction",
    ]);
  });

  it("uses POST", () => {
    assert.match(code, /curl [^\n]*-X POST/);
  });

  it("authenticates with the existing WORKER_SECRET as a Bearer header, never a literal", () => {
    assert.match(code, /WORKER_SECRET:\s*\$\{\{\s*secrets\.WORKER_SECRET\s*\}\}/);
    assert.match(code, /Authorization: Bearer \$\{WORKER_SECRET\}/);
    assert.doesNotMatch(code, /secrets\.(?!WORKER_SECRET\b)\w+/);
    assert.doesNotMatch(code, /worker[_-]?secret=/i);
  });

  it("never echoes the secret value", () => {
    for (const line of code.split("\n").filter((l) => /\becho\b/.test(l))) {
      assert.doesNotMatch(line, /\$\{?WORKER_SECRET\}?/);
    }
  });

  it("HTTP client timeout safely exceeds the 120 s provider timeout", () => {
    const match = code.match(/--max-time\s+(\d+)/);
    assert.ok(match, "curl --max-time must be set");
    assert.ok(Number(match[1]) >= 240, `expected >= 240 s, got ${match[1]}`);
  });

  it("job timeout exceeds the HTTP timeout but stays bounded", () => {
    const http = Number(code.match(/--max-time\s+(\d+)/)?.[1]);
    const job = Number(code.match(/timeout-minutes:\s*(\d+)/)?.[1]);
    assert.ok(job * 60 > http, "job timeout must exceed the curl timeout");
    assert.ok(job <= 10, `expected a bounded job timeout, got ${job}`);
  });

  it("surfaces a non-2xx (or no-response) worker result as a failed run", () => {
    assert.match(code, /2\?\?\)\s*;;/);
    assert.match(code, /\*\)[\s\S]*::error::[\s\S]*exit 1/);
  });

  it("makes exactly one worker POST per tick, with no in-run retry or polling loop", () => {
    assert.equal((code.match(/curl\b/g) ?? []).length, 1);
    assert.doesNotMatch(code, /\b(for|while|until)\b\s.*\bdo\b/);
    assert.doesNotMatch(code, /\bsleep\b/);
    assert.doesNotMatch(code, /--retry/);
  });

  it("serializes overlapping runs without cancelling an in-progress one", () => {
    assert.match(code, /concurrency:\s*\n\s*group:\s*artwork-reconstruction-worker-trigger/);
    assert.match(code, /cancel-in-progress:\s*false/);
    assert.doesNotMatch(code, /cancel-in-progress:\s*true/);
  });
});
