import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import QRCode from "qrcode";

import { fillRect, makeImage, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * QR REPAIR V2 (Section C/S): actor provenance for `confirmSignQrDestination`
 * must be entirely SERVER-derived per route, never trusted from a client-
 * submitted field. This file proves both routes independently, and proves
 * a client cannot spoof either value — the request body schemas do not
 * even define a `confirmedBy` field, so nothing a client sends can reach
 * it regardless of session state.
 */
describe("actor provenance: sign-artwork/qr-destination (customer vs internal)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-qr-destination-provenance-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshGraph() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { getProjectRepository } = await import("@/lib/db");
    return { graph, repo: getProjectRepository() };
  }

  /** A real, high-confidence-localizable, genuinely undecodable QR — same fixture shape as `sign-qr-preservation-service.test.ts`'s own. */
  async function signWithBrokenQr(): Promise<Buffer> {
    const image = makeImage(600, 900, { r: 250, g: 250, b: 250 });
    fillRect(image, 20, 20, 580, 100, { r: 30, g: 30, b: 30 });
    const buf = await QRCode.toBuffer("https://example-test-business.com/original-broken", {
      errorCorrectionLevel: "H",
      margin: 4,
      width: 150,
    });
    const { PNG } = await import("pngjs");
    const damaged = PNG.sync.read(buf);
    const y0 = Math.floor(damaged.height * 0.25);
    const y1 = y0 + Math.floor(damaged.height * 0.5);
    const x0 = Math.floor(damaged.width * 0.25);
    const x1 = x0 + Math.floor(damaged.width * 0.5);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * damaged.width + x) * 4;
        const v = (x + y) % 2 === 0 ? 0 : 255;
        damaged.data[i] = v;
        damaged.data[i + 1] = v;
        damaged.data[i + 2] = v;
      }
    }
    const atX = 400;
    const atY = 700;
    for (let y = 0; y < damaged.height; y++) {
      for (let x = 0; x < damaged.width; x++) {
        const si = (y * damaged.width + x) * 4;
        const dx = atX + x;
        const dy = atY + y;
        if (dx < 0 || dx >= image.width || dy < 0 || dy >= image.height) continue;
        const di = (dy * image.width + dx) * 4;
        image.data[di] = damaged.data[si];
        image.data[di + 1] = damaged.data[si + 1];
        image.data[di + 2] = damaged.data[si + 2];
        image.data[di + 3] = 255;
      }
    }
    return toPngBytes(image);
  }

  async function projectWithUndecodableQr(
    graph: Awaited<ReturnType<typeof freshGraph>>["graph"],
    repo: Awaited<ReturnType<typeof freshGraph>>["repo"],
  ) {
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: await signWithBrokenQr(),
      declaredContentType: "image/png",
      filename: "sign-with-broken-qr.png",
    });
    const preparation = await repo.getSignPreparation(projectId);
    const { scanForQrFinderPatterns } = await import("@/capabilities/machine-readable-content/qr-detect-decode");
    const { deriveRegionKey } = await import("@/capabilities/machine-readable-content/qr-resolution");
    const { PNG } = await import("pngjs");
    const downloaded = await graph.assets.downloadAssetBytes(preparation!.originalAssetId);
    const png = PNG.sync.read(downloaded!.bytes);
    const found = scanForQrFinderPatterns({ width: png.width, height: png.height, data: Buffer.from(png.data) });
    assert.equal(found.length, 1, "sanity: the fixture must produce exactly one detectable region");
    const regionKey = deriveRegionKey(found[0].bounds);
    return { projectId, regionKey };
  }

  function cookieHeaderFor(sessionToken: string): { cookie: string } {
    return { cookie: `ihp_as=${sessionToken}` };
  }

  async function postCustomer(projectId: string, body: Record<string, unknown>) {
    const route = await import("./route");
    return route.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ projectId }) },
    );
  }

  async function postInternal(projectId: string, body: Record<string, unknown>, headers?: Record<string, string>) {
    const route = await import("@/app/api/internal/projects/[projectId]/sign-artwork/qr-destination/route");
    return route.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "content-type": "application/json", ...(headers ?? {}) },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ projectId }) },
    );
  }

  it("customer route: persists confirmedBy 'customer' with no session at all — the project id is the credential, by design", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId, regionKey } = await projectWithUndecodableQr(graph, repo);

    const res = await postCustomer(projectId, { regionKey, destination: "https://example.com/booking" });
    assert.equal(res.status, 200);

    const preparation = await repo.getSignPreparation(projectId);
    const resolutions = (preparation?.qrResolutions ?? []) as Array<Record<string, unknown>>;
    assert.equal(resolutions.length, 1);
    assert.equal(resolutions[0].confirmedBy, "customer");
  });

  it("customer route: a client-submitted confirmedBy in the request body is silently ignored — the schema never defines the field, and the route hardcodes 'customer' regardless", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId, regionKey } = await projectWithUndecodableQr(graph, repo);

    const res = await postCustomer(projectId, {
      regionKey,
      destination: "https://example.com/booking",
      confirmedBy: "operator", // attempted spoof
    });
    assert.equal(res.status, 200);

    const preparation = await repo.getSignPreparation(projectId);
    const resolutions = (preparation?.qrResolutions ?? []) as Array<Record<string, unknown>>;
    assert.equal(resolutions[0].confirmedBy, "customer", "a client-submitted confirmedBy must never override the server-stamped actor");
  });

  it("internal route: refused with no session at all (403) — no resolution is persisted", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId, regionKey } = await projectWithUndecodableQr(graph, repo);

    const res = await postInternal(projectId, { regionKey, destination: "https://example.com/booking" });
    assert.equal(res.status, 403);

    const preparation = await repo.getSignPreparation(projectId);
    assert.ok(!preparation?.qrResolutions || preparation.qrResolutions.length === 0);
  });

  it("internal route: an ordinary (non-internal) session is refused identically — knowing a real project id is insufficient", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId, regionKey } = await projectWithUndecodableQr(graph, repo);
    const ordinarySession = await graph.acquisition.resolveOrCreateSession(null);

    const res = await postInternal(
      projectId,
      { regionKey, destination: "https://example.com/booking" },
      cookieHeaderFor(ordinarySession.sessionToken),
    );
    assert.equal(res.status, 403);
  });

  it("internal route: a valid internal session persists confirmedBy 'operator'", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId, regionKey } = await projectWithUndecodableQr(graph, repo);
    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);

    const res = await postInternal(
      projectId,
      { regionKey, destination: "https://example.com/booking" },
      cookieHeaderFor(internalSession.sessionToken),
    );
    assert.equal(res.status, 200);

    const preparation = await repo.getSignPreparation(projectId);
    const resolutions = (preparation?.qrResolutions ?? []) as Array<Record<string, unknown>>;
    assert.equal(resolutions[0].confirmedBy, "operator");
  });

  it("internal route: a client-submitted confirmedBy in the request body is silently ignored even WITH a valid internal session", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId, regionKey } = await projectWithUndecodableQr(graph, repo);
    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);

    const res = await postInternal(
      projectId,
      { regionKey, destination: "https://example.com/booking", confirmedBy: "customer" }, // attempted spoof
      cookieHeaderFor(internalSession.sessionToken),
    );
    assert.equal(res.status, 200);

    const preparation = await repo.getSignPreparation(projectId);
    const resolutions = (preparation?.qrResolutions ?? []) as Array<Record<string, unknown>>;
    assert.equal(resolutions[0].confirmedBy, "operator", "a client-submitted confirmedBy must never override the server-stamped actor");
  });
});
