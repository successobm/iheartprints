import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Production Operator Access Blocker fix: "Get internal access" from THIS
 * page must carry the operator back to THIS exact project, not lose their
 * place at the site root. Source-inspection only (mirrors
 * `internal-access-page.test.ts`'s own pattern) — this page is a Server
 * Component this repo's test tooling cannot render directly (no DOM, no
 * Next.js request context).
 */
describe("Production Operator Access Blocker fix — sign-authorize's 'Get internal access' link", () => {
  const pageSource = readFileSync(path.join(__dirname, "page.tsx"), "utf8");

  it("carries this exact project's Sign Production Review URL as returnTo", () => {
    assert.match(
      pageSource,
      /\/internal\/access\?returnTo=\$\{encodeURIComponent\(`\/internal\/projects\/\$\{projectId\}\/sign-authorize`\)\}/,
    );
  });

  it("never links to /internal/access with no returnTo at all", () => {
    assert.doesNotMatch(pageSource, /href="\/internal\/access"/);
  });
});
