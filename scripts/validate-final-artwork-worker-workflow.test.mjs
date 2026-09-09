import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Make Final Artwork Worker Run Automatically In Production Phase:
 * structural assertions on the committed GitHub Actions workflow that
 * makes the existing final-artwork worker run automatically in
 * production. Plain-text/regex checks on the raw file, mirroring this
 * repo's established source-inspection pattern for config the test
 * runner cannot otherwise mount (`js-yaml` is only a transitive
 * dependency here, not a declared one — never added to a committed test
 * just to parse one file).
 */
const source = readFileSync(".github/workflows/final-artwork-worker.yml", "utf8");

describe("final-artwork-worker.yml", () => {
  it("triggers on a schedule — never requires a manual click to run", () => {
    assert.match(source, /\n\s*schedule:\s*\n\s*-\s*cron:\s*"\*\/5 \* \* \* \*"/);
  });

  it("also exposes workflow_dispatch, but only as an OPTIONAL manual override, never the sole trigger", () => {
    assert.match(source, /workflow_dispatch:\s*\{\}/);
    // The schedule trigger, asserted above, still exists independently —
    // this is additive, not a replacement.
  });

  it("has a bounded job timeout — never a runaway workflow", () => {
    const match = source.match(/timeout-minutes:\s*(\d+)/);
    assert.ok(match, "sanity: timeout-minutes must be set");
    const minutes = Number(match[1]);
    assert.ok(minutes > 0 && minutes <= 10, `expected a small bounded timeout, got ${minutes}`);
  });

  it("declares a concurrency group so redundant runners never pile up (never required for correctness, but good hygiene)", () => {
    assert.match(source, /concurrency:\s*\n\s*group:\s*\S+/);
  });

  it("calls the real production final-artwork worker endpoint, never a placeholder", () => {
    assert.match(source, /https:\/\/iheartprints-88sjr\.ondigitalocean\.app\/api\/worker\/final-artwork/);
  });

  it("authenticates via the Authorization: Bearer header, the SAME mechanism the route itself already verifies — never a query string, never a body field", () => {
    assert.match(source, /Authorization: Bearer \$\{WORKER_SECRET\}/);
    assert.doesNotMatch(source, /worker[_-]?secret=/i);
  });

  it("reads the secret ONLY from GitHub's own encrypted secret store, by name — never a literal value anywhere in this file", () => {
    assert.match(source, /WORKER_SECRET:\s*\$\{\{\s*secrets\.WORKER_SECRET\s*\}\}/);
    // No quoted string long enough to plausibly be a real secret value.
    assert.doesNotMatch(source, /WORKER_SECRET:\s*["'][^$][^"']{16,}["']/);
  });

  it("fails loudly and immediately if the WORKER_SECRET repository secret was never configured", () => {
    assert.match(source, /if \[ -z "\$\{WORKER_SECRET:-\}" \]; then/);
    assert.match(source, /exit 1/);
  });

  it("polls roughly once a minute within each scheduled tick — matches docs/deployment/final-artwork-worker.md's own documented cadence, never a bare 5-minute-only interval", () => {
    assert.match(source, /sleep 60/);
    // Four attempts, 60s apart, comfortably inside the 5-minute outer tick.
    const attempts = source.match(/final-artwork worker trigger #\$i/g) ?? [];
    assert.ok(attempts.length >= 1, "sanity: the loop must log each attempt");
    assert.match(source, /for i in 1 2 3 4; do/);
  });

  it("fails the run only when EVERY attempt in the window failed — never over-alerts on one transient blip", () => {
    assert.match(source, /success_count=\$\(\(success_count \+ 1\)\)/);
    assert.match(source, /if \[ "\$success_count" -eq 0 \]; then/);
  });

  it("never echoes the secret's own shell-interpolated value — only its bare name appears in log/error text", () => {
    const echoLines = source.split("\n").filter((line) => /\becho\b/.test(line));
    for (const line of echoLines) {
      assert.doesNotMatch(
        line,
        /\$\{?WORKER_SECRET\}?/,
        `an echo line must never interpolate the secret's value: ${line.trim()}`,
      );
    }
  });
});
