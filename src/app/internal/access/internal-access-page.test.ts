import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveInternalAccessPageState } from "./internal-access-page-state";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");

/**
 * Phase 28M.1: proves the new operator-entry page's own render-branch logic
 * and the security properties its Section 8 explicitly demands of the raw
 * key's handling. Does NOT re-test `verifyInternalAccessKey`,
 * `grantInternalEntitlement`, or the `/api/internal/acquisition-access`
 * route itself -- those are unchanged this phase and already proven by
 * `acquisition-access-route.test.ts` (Phase 28M).
 */
describe("Phase 28M.1 — internal access page state", () => {
  it("not configured takes priority over everything else", () => {
    assert.equal(
      resolveInternalAccessPageState({ configured: false, alreadyInternal: true }),
      "unconfigured",
    );
    assert.equal(
      resolveInternalAccessPageState({ configured: false, alreadyInternal: false }),
      "unconfigured",
    );
  });

  it("configured + already internal shows the shortcut, not the form", () => {
    assert.equal(
      resolveInternalAccessPageState({ configured: true, alreadyInternal: true }),
      "already_internal",
    );
  });

  it("configured + not yet internal shows the form", () => {
    assert.equal(
      resolveInternalAccessPageState({ configured: true, alreadyInternal: false }),
      "needs_key",
    );
  });
});

describe("Phase 28M.1 — the raw key is never mishandled in the new UI", () => {
  const formSource = readFileSync(
    path.join(ROOT, "src", "app", "internal", "access", "InternalAccessForm.tsx"),
    "utf8",
  );
  const pageSource = readFileSync(path.join(ROOT, "src", "app", "internal", "access", "page.tsx"), "utf8");

  it("the form never touches localStorage or sessionStorage", () => {
    // Property/method access, not a bare word match -- this file's own doc
    // comment names both storages, by name, as things to never do.
    assert.doesNotMatch(formSource, /(localStorage|sessionStorage)\s*\./);
  });

  it("the form never logs anything (no actual console.*(...) call anywhere in it)", () => {
    // An actual call, not a bare word match -- this file's own doc comment
    // names `console.log` by name as a thing to never do.
    assert.doesNotMatch(formSource, /console\.\w+\(/);
  });

  it("the key is sent via the established header constant, never a query string or URL", () => {
    assert.match(formSource, /INTERNAL_ACCESS_KEY_HEADER/);
    assert.doesNotMatch(formSource, /fetch\([^)]*\?[^)]*key/i);
  });

  it("the key is never rendered back into the DOM as visible text (its ONE legitimate appearance is the controlled input's own `value` prop)", () => {
    const occurrences = formSource.match(/\{key\}/g) ?? [];
    assert.equal(occurrences.length, 1, "the `key` state variable must appear in JSX exactly once -- bound to the input it came from, nowhere else");
    assert.match(formSource, /value=\{key\}/, "that one appearance must be the controlled input's own value binding");
  });

  it("the page never logs a session token or the key", () => {
    assert.doesNotMatch(pageSource, /console\.\w+\(/);
  });

  it("neither file hardcodes a key-shaped literal or reads a NEXT_PUBLIC_ variable for it", () => {
    for (const source of [formSource, pageSource]) {
      assert.doesNotMatch(source, /NEXT_PUBLIC_[A-Z_]*KEY/);
      assert.doesNotMatch(source, /IHEARTPRINTS_INTERNAL_ACCESS_KEY\s*=\s*["']/);
    }
  });

  it("the 'already internal' shortcut looks up the session by TOKEN, never by internal id", () => {
    // Phase 28P bugfix regression: the cookie carries `session.sessionToken`
    // (see `acquisition-access-route.test.ts`'s own `cookieFromResponse`),
    // and `getAcquisitionSession(sessionId)` filters by the internal `id`
    // column -- a different value entirely (`local-store.ts`/
    // `supabase-store.ts` both implement it that way). Calling that method
    // with a cookie's raw token silently never matches, so `alreadyInternal`
    // was always false and this page's own "already granted" shortcut never
    // actually fired. The fix is exactly one call:
    // `getAcquisitionSessionByToken`.
    assert.match(pageSource, /getAcquisitionSessionByToken\(token\)/);
    assert.doesNotMatch(pageSource, /getAcquisitionSession\(token\)/);
  });
});

describe("Phase 28P — the 'already internal' shortcut actually recognizes a real internal session", () => {
  // The Server Component page itself cannot be invoked directly by this
  // repo's test tooling (no DOM, no Next.js request context -- see this
  // file's own doc comment above). This proves the exact repository
  // round-trip the fixed page now performs: grant internal entitlement via
  // the real route, then resolve the SAME cookie value the page reads back
  // to an internal session using the corrected lookup method.
  it("a cookie's raw token resolves to the granted internal session via getAcquisitionSessionByToken", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-already-internal-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const previousKeyEnv = process.env.IHEARTPRINTS_INTERNAL_ACCESS_KEY;
    process.env.IHEARTPRINTS_INTERNAL_ACCESS_KEY = "test-only-internal-access-key-0123456789";

    try {
      const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
      resetCapabilityGraphForTests();
      const graph = getCapabilityGraph();
      const { getProjectRepository } = await import("@/lib/db");
      const repo = getProjectRepository();

      const session = await graph.acquisition.resolveOrCreateSession(null);
      await repo.grantInternalEntitlement(session.id);

      // Exactly what the cookie carries -- see `ACQUISITION_SESSION_COOKIE`'s
      // doc comment and `/api/projects/route.ts`'s `response.cookies.set`.
      const cookieValue = session.sessionToken;

      const wrongLookup = await repo.getAcquisitionSession(cookieValue);
      assert.equal(wrongLookup, null, "the OLD buggy lookup must not accidentally match");

      const correctLookup = await repo.getAcquisitionSessionByToken(cookieValue);
      assert.equal(correctLookup?.entitlement, "internal");
    } finally {
      if (previousKeyEnv === undefined) delete process.env.IHEARTPRINTS_INTERNAL_ACCESS_KEY;
      else process.env.IHEARTPRINTS_INTERNAL_ACCESS_KEY = previousKeyEnv;
      const { cleanupTempWorkspace } = await import("@/test-support/cleanup-temp-workspace");
      await cleanupTempWorkspace(tempDir, previousCwd);
    }
  });
});
