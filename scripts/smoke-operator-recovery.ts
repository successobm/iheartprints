/**
 * Print'em All Phase 2 — LOCAL OPERATOR-RECOVERY SMOKE, over the REAL HTTP
 * route handlers.
 *
 * WHAT THIS PROVES THAT A CAPABILITY TEST DOES NOT.
 *
 * The live failure was reported from a browser, so the honest question is
 * whether the whole request path works: route body parsing, the status codes
 * the client branches on, the capability graph the routes resolve, the
 * repository write, and the snapshot the client re-renders from. This script
 * drives the ACTUAL exported `POST`/`GET` handlers with real `Request`
 * objects — the same functions Next.js invokes — rather than calling
 * capabilities directly.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not drive a browser. This repo has
 * no browser automation and Goal 9 says not to add a framework for this alone,
 * so the boundary proven here is HTTP-in / JSON-out plus a server render of
 * the resulting snapshot. Click handling itself is covered by the render tests
 * in `production-treatment-dead-end.test.tsx`.
 *
 * NO EXTERNAL PROVIDERS. Local persistence, local deterministic halftone
 * engine, and a reconstruction provider that throws if anything reaches for
 * it. No Topaz, no OpenAI, no Stripe.
 *
 *   npx tsx scripts/smoke-operator-recovery.ts
 */

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";

process.env.IHEARTPRINTS_AUTOMATED_TEST = "1";

const previousCwd = process.cwd();
const workspace = mkdtempSync(path.join(tmpdir(), "iheartprints-smoke-"));

const results: { step: string; ok: boolean; detail: string }[] = [];

function record(step: string, ok: boolean, detail: string) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}\n        ${detail}`);
}

function preparedPng(): Buffer {
  const W = 584;
  const H = 640;
  const AW = 562;
  const AH = 486;
  const png = new PNG({ width: W, height: H });
  const ix = Math.floor((W - AW) / 2);
  const iy = Math.floor((H - AH) / 2);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (W * y + x) << 2;
      if (x < ix || x >= ix + AW || y < iy || y >= iy + AH) continue;
      const level = Math.round((((x - ix) / (AW - 1) + (y - iy) / (AH - 1)) / 2) * 255);
      png.data[i] = level;
      png.data[i + 1] = Math.round(level * 0.72);
      png.data[i + 2] = Math.round(level * 0.4);
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function main() {
  process.chdir(workspace);
  await rm(path.join(workspace, ".data"), { recursive: true, force: true });

  const { getProjectRepository } = await import("@/lib/db");
  const { getCapabilityGraph } = await import("@/capabilities/composition");
  const { createAssetCapability, PngThumbnailGenerator } = await import(
    "@/capabilities/assets"
  );
  const { DataUriAssetStorageProvider } = await import("@/capabilities/asset-storage");
  const { createFinalArtworkWorkerCapability } = await import(
    "@/capabilities/final-artwork-worker"
  );
  const { createPrintValidationCapability } = await import(
    "@/capabilities/print-validation"
  );
  const { LocalRasterInterpolationProvider } = await import(
    "@/capabilities/final-artwork/local-raster-provider"
  );

  const repo = getProjectRepository();
  const graph = getCapabilityGraph();
  const assets = createAssetCapability(
    repo,
    new DataUriAssetStorageProvider(),
    new PngThumbnailGenerator(),
  );

  // --- build the LIVE FAILURE SHAPE ---------------------------------------
  const session = await graph.acquisition.resolveOrCreateSession(null);
  await repo.grantInternalEntitlement(session.id);
  const created = await repo.createProject(session.id);
  const projectId = created.project.id;

  await repo.updateBrief(projectId, {
    productSummary: "T-shirts for our bowling team",
    shirtColor: "Black",
    printPlacement: "full_back",
  });

  const original = await assets.uploadCustomerArtwork(projectId, {
    conceptId: "upload-original",
    bytes: preparedPng(),
    contentType: "image/png",
    widthPx: 584,
    heightPx: 640,
    hasTransparency: false,
    kind: "customer_upload",
    metadata: { originalFilename: "team artwork.png" },
  });
  const preparation = await repo.createArtworkPreparation(projectId, {
    originalAssetId: original.id,
    originalFilename: "team artwork.png",
    analysis: { widthPx: 584, heightPx: 640 },
  });
  const prepared = await assets.uploadCustomerArtwork(projectId, {
    conceptId: `prepared-${preparation.id}`,
    bytes: preparedPng(),
    contentType: "image/png",
    widthPx: 584,
    heightPx: 640,
    hasTransparency: true,
    kind: "png",
    metadata: { derivedFromAssetId: original.id },
  });
  await repo.updateArtworkPreparation(preparation.id, {
    status: "prepared",
    preparedAssetId: prepared.id,
    preparation: { backgroundRemoved: true },
  });
  const [artwork] = await repo.addArtworkVersions(projectId, [
    {
      versionNumber: 1,
      kind: "prepared_upload",
      title: "Your artwork, prepared",
      summary: "Your uploaded artwork with its background removed.",
      placeholderLabel: "Your artwork",
      accentColor: "#173F35",
      designBriefVersionId: null,
      generationJobId: null,
      providerKey: null,
      primaryAssetId: prepared.id,
      thumbnailAssetId: null,
      sourceArtworkVersionId: null,
      conceptDirectionKey: null,
    },
  ]);
  await repo.updateArtworkPreparation(preparation.id, {
    status: "approved",
    preparedArtworkVersionId: artwork!.id,
    approvedAt: "2026-08-20T00:00:00.000Z",
  });

  const failedJob = await repo.createFinalArtworkJob(projectId, {
    sourceKind: "prepared_upload",
    artworkPreparationId: preparation.id,
    artworkVersionId: artwork!.id,
    productionWidthIn: 10.5,
    requestedProductionOutput: "production_png",
    productionTreatmentKey: "standard_raster",
  });
  const historical = await repo.updateFinalArtworkJob(failedJob.id, {
    status: "failed",
    lastError: "This artwork cannot be reconstructed to the size this print requires.",
    completedAt: "2026-08-20T01:00:00.000Z",
  });
  // Exactly what `failJob` leaves behind, and the whole cause of the dead end.
  await repo.setProjectStatus(projectId, "finalizing");

  console.log(`\nproject ${projectId}`);
  console.log(`project.status        finalizing (sticky, after a failed job)`);
  console.log(`failed job            ${historical.id} (${historical.status})\n`);

  // --- drive the REAL route handlers --------------------------------------
  const ctx = { params: Promise.resolve({ projectId }) };
  const post = (url: string, body: unknown) =>
    new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const confirmRoute = await import(
    "@/app/api/projects/[projectId]/print-size/confirm/route"
  );
  const printSizeRoute = await import("@/app/api/projects/[projectId]/print-size/route");
  const treatmentRoute = await import(
    "@/app/api/projects/[projectId]/production-treatment/route"
  );
  // The upload workflow's production action is the artwork-preparation route
  // with `action: "print_ready"` — exactly what the panel's button posts.
  // `/finalize` is the Create New path and would 400 here, which is correct.
  const preparationRoute = await import(
    "@/app/api/projects/[projectId]/artwork-preparation/route"
  );

  // 1. Click: "Standard Adult"
  let res = await confirmRoute.POST(
    post(`/api/projects/${projectId}/print-size/confirm`, {
      garmentSizeClass: "adult_standard",
    }),
    ctx,
  );
  let body = (await res.json()) as Record<string, never>;
  record(
    'click "Standard Adult"',
    res.status === 200,
    `HTTP ${res.status}; garmentSizeClass=${(body as never as { brief: { garmentSizeClass: string } }).brief?.garmentSizeClass}`,
  );

  // 2. Click: "Use recommended size"
  res = await confirmRoute.POST(
    post(`/api/projects/${projectId}/print-size/confirm`, { useRecommended: true }),
    ctx,
  );
  body = (await res.json()) as Record<string, never>;
  const confirmed = body as never as {
    brief: { productionSizeConfirmedAt: string | null; productionSizeConfirmedWidthIn: number | null };
    printReadySize: { confirmed: boolean; blockingMessage: string | null } | null;
    productionTreatment?: { offerable: boolean; offerBlockedReason: string | null };
  };
  record(
    'click "Use recommended size"',
    res.status === 200 &&
      confirmed.brief.productionSizeConfirmedWidthIn === 10.5 &&
      Boolean(confirmed.brief.productionSizeConfirmedAt),
    `HTTP ${res.status}; confirmed ${confirmed.brief.productionSizeConfirmedWidthIn}in at ${confirmed.brief.productionSizeConfirmedAt}`,
  );
  record(
    "size card now reads confirmed",
    confirmed.printReadySize?.confirmed === true &&
      confirmed.printReadySize?.blockingMessage === null,
    `confirmed=${confirmed.printReadySize?.confirmed} blocking=${JSON.stringify(confirmed.printReadySize?.blockingMessage)}`,
  );
  record(
    "DTF Halftone becomes offerable",
    confirmed.productionTreatment?.offerable === true,
    `offerable=${confirmed.productionTreatment?.offerable} reason=${JSON.stringify(confirmed.productionTreatment?.offerBlockedReason)}`,
  );

  // 3. An explicit width also confirms (the preset chips / Adjust control)
  res = await printSizeRoute.POST(
    post(`/api/projects/${projectId}/print-size`, { widthIn: 12 }),
    ctx,
  );
  const explicit = (await res.json()) as never as {
    brief: { productionSizeConfirmedWidthIn: number | null };
  };
  record(
    'click preset width 12"',
    res.status === 200 && explicit.brief.productionSizeConfirmedWidthIn === 12,
    `HTTP ${res.status}; confirmed ${explicit.brief.productionSizeConfirmedWidthIn}in`,
  );

  // Back to a small, fast plate for the rest of the run.
  await printSizeRoute.POST(
    post(`/api/projects/${projectId}/print-size`, { widthIn: 4 }),
    ctx,
  );

  // 4. Click: "DTF Halftone"
  res = await treatmentRoute.POST(
    post(`/api/projects/${projectId}/production-treatment`, {
      treatment: "halftone_dtf",
      halftone: { lpi: 35 },
    }),
    ctx,
  );
  const treated = (await res.json()) as never as {
    brief: { productionTreatment: string; halftoneSettings: Record<string, unknown> | null };
  };
  record(
    'click "DTF Halftone"',
    res.status === 200 && treated.brief.productionTreatment === "halftone_dtf",
    `HTTP ${res.status}; treatment=${treated.brief.productionTreatment} lpi=${(treated.brief.halftoneSettings as { lpi?: number } | null)?.lpi}`,
  );

  // 5. Click: the production action
  res = await preparationRoute.POST(
    post(`/api/projects/${projectId}/artwork-preparation`, {
      action: "print_ready",
    }),
    ctx,
  );
  const requested = (await res.json()) as never as { error?: string };
  record(
    "click the production action",
    res.status === 200,
    `HTTP ${res.status}${requested.error ? ` — ${requested.error}` : ""}`,
  );

  // 6. Run the real worker with a paid provider that THROWS if reached.
  let paidCalls = 0;
  const worker = createFinalArtworkWorkerCapability(
    repo,
    assets,
    {
      providerKey: "forbidden_paid_reconstruction",
      async produce() {
        paidCalls += 1;
        throw new Error("PAID PROVIDER REACHED");
      },
    } as never,
    createPrintValidationCapability(),
    {
      async evaluate() {
        throw new Error("Concept Evaluation must never run for uploaded artwork");
      },
    } as never,
    new LocalRasterInterpolationProvider(),
  );
  await worker.processNextJob();

  // 7. The snapshot the browser would re-render from.
  const snapshotRoute = await import("@/app/api/projects/[projectId]/route");
  res = await snapshotRoute.GET(
    new Request(`http://localhost/api/projects/${projectId}`),
    ctx,
  );
  const final = (await res.json()) as never as {
    project: { status: string };
    finalization: { status: string };
  };
  record(
    "project reaches print_ready",
    final.project.status === "print_ready",
    `project.status=${final.project.status} finalization.status=${final.finalization.status}`,
  );
  record("zero paid provider calls", paidCalls === 0, `paidCalls=${paidCalls}`);

  const after = await repo.getFinalArtworkJob(historical.id);
  record(
    "old failed Standard Raster job untouched",
    after?.status === "failed" &&
      after?.lastError === historical.lastError &&
      after?.productionTreatmentKey === "standard_raster",
    `status=${after?.status} treatmentKey=${after?.productionTreatmentKey}`,
  );

  const jobs = await repo.listFinalArtworkJobsForPreparation(projectId, preparation.id);
  const halftoneJob = jobs.find((j) => j.id !== historical.id);
  record(
    "new halftone job is distinct",
    Boolean(halftoneJob) &&
      String(halftoneJob!.productionTreatmentKey).startsWith("halftone_dtf/"),
    `jobs=${jobs.length} newKey=${halftoneJob?.productionTreatmentKey}`,
  );

  const failures = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failures.length}/${results.length} smoke steps passed`,
  );
  if (failures.length > 0) {
    console.log("FAILED STEPS:");
    for (const f of failures) console.log(`  - ${f.step}: ${f.detail}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  });
