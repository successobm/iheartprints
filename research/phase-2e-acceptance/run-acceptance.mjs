/**
 * Sprint 2M Phase 2E — controlled live acceptance driver (HTTP only).
 * Research/ops script — not part of the app test suite.
 *
 * Exactly one Topaz paid reconstruction expected on first final-artwork
 * worker invoke; second invoke must consume zero additional credits.
 */
import fs from "node:fs";
import path from "node:path";

function loadDotEnvLocal() {
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const n = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!process.env[n]) process.env[n] = v;
  }
}

loadDotEnvLocal();

const BASE = process.env.ACCEPTANCE_BASE_URL || "http://localhost:3000";
const WORKER_SECRET =
  process.env.WORKER_SECRET ||
  "iheartprints-local-dev-worker-secret-do-not-use-in-production";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT_DIR = path.resolve("research/phase-2e-acceptance");
fs.mkdirSync(OUT_DIR, { recursive: true });

const ANSWERS = {
  product: "bowling league team t-shirts",
  graphics: "A retro bowling team logo with three stylized faces",
  productColor: "Black",
  printLocation: "Full back",
  requiredWording: "My 3 Sons",
  style: "Retro mid-century",
  colors: "Cream and burnt orange on black",
  audience: "Adult bowling league team",
  purpose: "Team shirts for league night",
  exclusions: "No photos of real people",
};

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function api(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body
      ? { "content-type": "application/json" }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    throw new Error(`${method} ${pathname} -> ${res.status}: ${text.slice(0, 600)}`);
  }
  return json;
}

async function worker(pathname) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "X-Worker-Secret": WORKER_SECRET },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    throw new Error(`WORKER ${pathname} -> ${res.status}: ${text.slice(0, 600)}`);
  }
  return json;
}

async function supabase(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supabase ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function topazCredits() {
  const res = await fetch("https://api.topazlabs.com/account/v1/credits/balance", {
    headers: { "X-API-Key": process.env.TOPAZ_API_KEY },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`credits ${res.status}`);
  return json;
}

async function driveInterview(projectId) {
  let snapshot = await api("GET", `/api/projects/${projectId}`);
  // Seed with an opener that establishes the design intent
  snapshot = await api("POST", `/api/projects/${projectId}/messages`, {
    content:
      "I want a retro bowling team logo for our league t-shirts. The team is called My 3 Sons and the wording My 3 Sons must appear exactly on the artwork. Full back placement on black shirts.",
  });

  for (let turn = 0; turn < 25; turn += 1) {
    if (snapshot.conversation.phase === "awaiting_summary_confirmation") {
      return snapshot;
    }
    const pending = snapshot.conversation.interviewState?.pendingSection;
    const reply = (pending && ANSWERS[pending]) || "You choose.";
    console.error(`interview turn ${turn + 1}: pending=${pending} reply=${JSON.stringify(reply)}`);
    snapshot = await api("POST", `/api/projects/${projectId}/messages`, {
      content: reply,
    });
  }
  throw new Error(
    `Interview stuck in phase=${snapshot.conversation.phase} pending=${snapshot.conversation.interviewState?.pendingSection}`,
  );
}

async function waitForConcepts(projectId, { timeoutMs = 15 * 60 * 1000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // Drive generation worker periodically
    await worker("/api/worker/generation");
    const status = await api("GET", `/api/projects/${projectId}/generation/status`);
    console.error(`generation status=${status.status}`);
    if (status.status === "ready") {
      return api("GET", `/api/projects/${projectId}`);
    }
    if (status.status === "failed") {
      throw new Error(`generation failed: ${JSON.stringify(status)}`);
    }
    await sleep(5000);
  }
  throw new Error("Timed out waiting for concepts");
}

async function waitForFinalization(projectId, { timeoutMs = 12 * 60 * 1000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshot = await api("GET", `/api/projects/${projectId}`);
    const st = snapshot.finalization?.status;
    console.error(`finalization.status=${st} project.status=${snapshot.project.status}`);
    if (st === "print_ready" || st === "needs_review") {
      return snapshot;
    }
    if (st !== "preparing" && st !== "not_requested") {
      return snapshot;
    }
    await sleep(5000);
  }
  throw new Error("Timed out waiting for finalization");
}

async function main() {
  console.error("BASE", BASE);
  console.error("FINAL_ARTWORK_PROVIDER", process.env.FINAL_ARTWORK_PROVIDER);

  const creditsBefore = await topazCredits();
  console.error("credits before", creditsBefore);

  const created = await api("POST", "/api/projects");
  const projectId = created.project.id;
  console.error("projectId", projectId, "persistence", created.persistenceMode);

  if (created.persistenceMode !== "supabase") {
    throw new Error(`Expected supabase persistence, got ${created.persistenceMode}`);
  }

  let snapshot = await driveInterview(projectId);
  console.error("brief at summary", {
    exactText: snapshot.brief?.exactText,
    printPlacement: snapshot.brief?.printPlacement,
    productSummary: snapshot.brief?.productSummary,
    phase: snapshot.conversation.phase,
  });

  snapshot = await api("POST", `/api/projects/${projectId}/brief/decision`, {
    action: "approve",
  });
  console.error("after approve status", snapshot.project.status);

  snapshot = await waitForConcepts(projectId);
  const concepts = snapshot.artworkVersions || [];
  console.error(
    "concepts",
    concepts.map((c) => ({ id: c.id, title: c.title, hasImage: c.hasImage })),
  );
  if (!concepts.length) throw new Error("No concepts");

  const chosen = concepts.find((c) => c.hasImage) || concepts[0];
  snapshot = await api("POST", `/api/projects/${projectId}/select`, {
    artworkVersionId: chosen.id,
  });
  console.error("selected", chosen.id, chosen.title);

  snapshot = await api("POST", `/api/projects/${projectId}/finalize`, {
    artworkVersionId: chosen.id,
  });
  console.error("after finalize", snapshot.finalization, snapshot.project.status);

  const jobsQueued = await supabase(
    `final_artwork_jobs?project_id=eq.${projectId}&select=id,status,artwork_version_id,provider_key,provider_request_id,provider_status,attempts,created_at`,
  );
  console.error("jobs after finalize", JSON.stringify(jobsQueued));
  if (jobsQueued.length !== 1) {
    throw new Error(`Expected exactly 1 FinalArtworkJob, got ${jobsQueued.length}`);
  }

  const creditsBeforeWorker = await topazCredits();
  console.error("credits before worker", creditsBeforeWorker);

  const worker1 = await worker("/api/worker/final-artwork");
  console.error("worker1", worker1);

  snapshot = await waitForFinalization(projectId);

  const creditsAfterWorker = await topazCredits();
  console.error("credits after worker1", creditsAfterWorker);

  const jobsAfter = await supabase(
    `final_artwork_jobs?project_id=eq.${projectId}&select=*`,
  );
  const assets = await supabase(
    `assets?project_id=eq.${projectId}&production_role=eq.production_png&select=id,width_px,height_px,has_transparency,content_type,final_artwork_job_id,production_role,metadata,created_at`,
  );
  const validations = await supabase(
    `production_asset_validations?project_id=eq.${projectId}&select=*`,
  );
  const approvals = await supabase(
    `final_direction_approvals?project_id=eq.${projectId}&select=id,status,artwork_version_id,created_at`,
  );

  // Source concept asset dimensions
  const conceptAssets = await supabase(
    `assets?project_id=eq.${projectId}&is_thumbnail=eq.false&production_role=is.null&select=id,width_px,height_px,has_transparency,content_type,storage_key&order=created_at.desc&limit=10`,
  );

  const worker2 = await worker("/api/worker/final-artwork");
  console.error("worker2", worker2);
  await sleep(3000);
  const creditsAfterWorker2 = await topazCredits();
  console.error("credits after worker2", creditsAfterWorker2);

  const jobsAfter2 = await supabase(
    `final_artwork_jobs?project_id=eq.${projectId}&select=id,status,provider_key,provider_request_id,provider_status,attempts`,
  );
  const assetsAfter2 = await supabase(
    `assets?project_id=eq.${projectId}&production_role=eq.production_png&select=id`,
  );
  const validationsAfter2 = await supabase(
    `production_asset_validations?project_id=eq.${projectId}&select=id`,
  );

  const report = {
    createdAt: new Date().toISOString(),
    preflight: {
      finalArtworkProvider: process.env.FINAL_ARTWORK_PROVIDER,
      supabaseHost: new URL(SUPABASE_URL).host,
    },
    projectId,
    chosenConcept: { id: chosen.id, title: chosen.title },
    brief: {
      exactText: snapshot.brief?.exactText,
      printPlacement: snapshot.brief?.printPlacement,
      productSummary: snapshot.brief?.productSummary,
    },
    customerFinalizationStatus: snapshot.finalization?.status,
    projectStatus: snapshot.project.status,
    credits: {
      scriptStart: creditsBefore,
      beforeWorker1: creditsBeforeWorker,
      afterWorker1: creditsAfterWorker,
      afterWorker2: creditsAfterWorker2,
      deltaWorker1:
        (creditsBeforeWorker.available_credits ?? 0) -
        (creditsAfterWorker.available_credits ?? 0),
      deltaWorker2:
        (creditsAfterWorker.available_credits ?? 0) -
        (creditsAfterWorker2.available_credits ?? 0),
    },
    jobsQueuedCount: jobsQueued.length,
    jobsAfter,
    conceptAssets,
    productionAssets: assets,
    validations,
    approvals,
    idempotency: {
      jobsCountAfterSecondWorker: jobsAfter2.length,
      productionAssetsCountAfterSecondWorker: assetsAfter2.length,
      validationsCountAfterSecondWorker: validationsAfter2.length,
      creditsUnchangedOnSecondWorker:
        creditsAfterWorker.available_credits === creditsAfterWorker2.available_credits,
    },
  };

  const outPath = path.join(OUT_DIR, `acceptance-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "acceptance-latest.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outPath, summary: {
    projectId,
    finalization: snapshot.finalization?.status,
    projectStatus: snapshot.project.status,
    creditsDelta1: report.credits.deltaWorker1,
    creditsDelta2: report.credits.deltaWorker2,
    jobs: jobsAfter.length,
    productionAssets: assets.length,
    validations: validations.length,
    productionMeta: assets[0]?.metadata ?? null,
    validationStatus: validations[0]?.status ?? null,
  }}, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
