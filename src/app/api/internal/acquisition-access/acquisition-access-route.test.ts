import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import {
  ACQUISITION_SESSION_COOKIE,
  readAcquisitionSessionToken,
} from "@/lib/http/acquisition-session-cookie";
import { INTERNAL_ACCESS_KEY_HEADER } from "@/lib/config/internal-access-config";
import { APPAREL_RASTER_PRODUCTION_PROFILE } from "@/lib/domain/types";

/**
 * Phase 28M: proves the ALREADY-EXISTING internal/system-admin access
 * mechanism (`POST /api/internal/acquisition-access`,
 * `IHEARTPRINTS_INTERNAL_ACCESS_KEY`) actually does what Eric needs it to
 * do -- grant a real browser session the internal entitlement so
 * `authorizeFinalization` allows production finalization with NO
 * `production_unlocks` row, WITHOUT weakening that same gate for an
 * ordinary customer -- and that it cannot be obtained any other way
 * (missing key, wrong key, being "on localhost", or naming a project by
 * id alone).
 *
 * No code changed to make this pass -- this file is verification of an
 * already-complete mechanism, per the phase's own Section 17 stop
 * condition.
 */
describe("Phase 28M — the internal/system-admin access mechanism", () => {
  let tempDir = "";
  let previousCwd = "";
  let originalKeyEnv: string | undefined;

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-internal-access-"));
    process.chdir(tempDir);
    originalKeyEnv = process.env.IHEARTPRINTS_INTERNAL_ACCESS_KEY;
    // A realistic-length TEST-ONLY key -- never the real configured value,
    // never printed, scoped to this describe block and restored after.
    process.env.IHEARTPRINTS_INTERNAL_ACCESS_KEY = "test-only-internal-access-key-0123456789";
  });

  after(async () => {
    if (originalKeyEnv === undefined) delete process.env.IHEARTPRINTS_INTERNAL_ACCESS_KEY;
    else process.env.IHEARTPRINTS_INTERNAL_ACCESS_KEY = originalKeyEnv;
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshGraph() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    return getCapabilityGraph();
  }

  function cookieFromResponse(res: Response): string | null {
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) return null;
    return readAcquisitionSessionToken(setCookie);
  }

  it("F: a missing internal key is refused with an uninformative 401 -- no session is granted, no cookie is set", async () => {
    await freshGraph();
    const route = await import("./route");
    const res = await route.POST(new Request("http://localhost/x", { method: "POST" }));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  it("F: a wrong internal key is refused identically to a missing one -- same status, same body, no cookie", async () => {
    await freshGraph();
    const route = await import("./route");
    const wrongRes = await route.POST(
      new Request("http://localhost/x", { method: "POST", headers: { [INTERNAL_ACCESS_KEY_HEADER]: "definitely-not-the-real-key" } }),
    );
    const missingRes = await route.POST(new Request("http://localhost/x", { method: "POST" }));
    assert.equal(wrongRes.status, missingRes.status);
    assert.deepEqual(await wrongRes.json(), await missingRes.json());
    assert.equal(wrongRes.headers.get("set-cookie"), null);
  });

  it("E: being 'on localhost' contributes nothing -- the exact same request without the header is refused regardless of origin/host framing", async () => {
    await freshGraph();
    const route = await import("./route");
    // No amount of localhost-flavored headers substitutes for the key.
    const res = await route.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { Host: "localhost:3929", Origin: "http://localhost:3929", Referer: "http://localhost:3929/" },
      }),
    );
    assert.equal(res.status, 401);
  });

  it("G: the correct internal key establishes a real internal session, returned as an httpOnly cookie", async () => {
    const graph = await freshGraph();
    const route = await import("./route");
    const res = await route.POST(
      new Request("http://localhost/x", { method: "POST", headers: { [INTERNAL_ACCESS_KEY_HEADER]: process.env.IHEARTPRINTS_INTERNAL_ACCESS_KEY! } }),
    );
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie");
    assert.ok(setCookie, "a session cookie must be issued");
    assert.match(setCookie!, /HttpOnly/i);
    assert.match(setCookie!, new RegExp(`^${ACQUISITION_SESSION_COOKIE}=`));

    const token = cookieFromResponse(res);
    assert.ok(token);
    const session = await graph.acquisition.resolveOrCreateSession(token);
    assert.equal(session.entitlement, "internal");
  });

  it("B/C: a project created under the internal session is recognized as internal, and finalization is allowed with ZERO production_unlocks rows", async () => {
    const graph = await freshGraph();
    const route = await import("./route");
    const grantRes = await route.POST(
      new Request("http://localhost/x", { method: "POST", headers: { [INTERNAL_ACCESS_KEY_HEADER]: process.env.IHEARTPRINTS_INTERNAL_ACCESS_KEY! } }),
    );
    const token = cookieFromResponse(grantRes);

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const session = await graph.acquisition.resolveOrCreateSession(token);
    const created = await repo.createProject(session.id);
    const projectId = created.project.id;

    assert.equal(await graph.acquisition.isInternalProject(projectId), true);

    const unlocks = await repo.getActiveProductionUnlock(projectId, APPAREL_RASTER_PRODUCTION_PROFILE).catch(() => null);
    assert.equal(unlocks, null, "no production_unlocks row exists for this project");

    const authorization = await graph.acquisition.authorizeFinalization(projectId);
    assert.equal(authorization.allowed, true, "internal authority must allow finalization with no purchase");
  });

  it("D/J: an ordinary project (no internal grant, no purchase) remains denied -- the commercial gate is completely untouched", async () => {
    const graph = await freshGraph();
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const ordinarySession = await graph.acquisition.resolveOrCreateSession(null);
    const created = await repo.createProject(ordinarySession.id);
    const projectId = created.project.id;

    assert.equal(await graph.acquisition.isInternalProject(projectId), false);
    const authorization = await graph.acquisition.authorizeFinalization(projectId);
    assert.equal(authorization.allowed, false);
  });

  it("I: internal authority does not leak to an unrelated project created under a DIFFERENT, ordinary session", async () => {
    const graph = await freshGraph();
    const route = await import("./route");
    const grantRes = await route.POST(
      new Request("http://localhost/x", { method: "POST", headers: { [INTERNAL_ACCESS_KEY_HEADER]: process.env.IHEARTPRINTS_INTERNAL_ACCESS_KEY! } }),
    );
    const internalToken = cookieFromResponse(grantRes);

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const internalSession = await graph.acquisition.resolveOrCreateSession(internalToken);
    const internalProject = await repo.createProject(internalSession.id);

    // A completely separate, ordinary browser/session -- never presented the key.
    const ordinarySession = await graph.acquisition.resolveOrCreateSession(null);
    const ordinaryProject = await repo.createProject(ordinarySession.id);

    assert.equal(await graph.acquisition.isInternalProject(internalProject.project.id), true);
    assert.equal(await graph.acquisition.isInternalProject(ordinaryProject.project.id), false, "an unrelated project must never inherit internal authority");
  });

  it("H: internal authority survives a simulated reload -- a brand new capability graph, resolving the SAME session token from a fresh 'Cookie' header, still reports internal", async () => {
    const graph = await freshGraph();
    const route = await import("./route");
    const grantRes = await route.POST(
      new Request("http://localhost/x", { method: "POST", headers: { [INTERNAL_ACCESS_KEY_HEADER]: process.env.IHEARTPRINTS_INTERNAL_ACCESS_KEY! } }),
    );
    const setCookie = grantRes.headers.get("set-cookie")!;
    const cookiePair = setCookie.split(";")[0]; // "ihp_as=<token>"

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const grantedSession = await graph.acquisition.resolveOrCreateSession(readAcquisitionSessionToken(setCookie));
    const created = await repo.createProject(grantedSession.id);

    // Simulate a real reload: brand new capability graph, token arriving the
    // way a real browser would resend it -- via a "Cookie" request header,
    // never re-presenting the internal key.
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const freshCapabilityGraph = getCapabilityGraph();
    const reloadedRequest = new Request("http://localhost/x", { headers: { cookie: cookiePair! } });
    const { readAcquisitionSessionTokenFromRequest } = await import("@/lib/http/acquisition-session-cookie");
    const reloadedToken = readAcquisitionSessionTokenFromRequest(reloadedRequest);
    const reloadedSession = await freshCapabilityGraph.acquisition.resolveOrCreateSession(reloadedToken);
    assert.equal(reloadedSession.entitlement, "internal");
    assert.equal(await freshCapabilityGraph.acquisition.isInternalProject(created.project.id), true);
  });

  it("manipulating projectId alone (no key, no cookie) never grants internal authority for an arbitrary project", async () => {
    const graph = await freshGraph();
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const ordinarySession = await graph.acquisition.resolveOrCreateSession(null);
    const created = await repo.createProject(ordinarySession.id);

    // No internal grant anywhere in this test. Merely knowing/naming the
    // project id must not confer internal authority.
    assert.equal(await graph.acquisition.isInternalProject(created.project.id), false);
  });
});
