/**
 * Sprint 2M Phase 2D — research-only Topaz reconstruction bake-off.
 *
 * Does NOT touch FinalArtworkProvider, Print Validation, FinalArtworkJob,
 * project status, or production_png assets.
 *
 * Usage:
 *   node research/phase-2d-bakeoff/run-bakeoff.mjs
 *
 * Requires TOPAZ_API_KEY in the environment (or .env.local loaded by caller).
 * Optional OPENAI_API_KEY for wording OCR via vision.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const SOURCES = path.join(ROOT, "sources");
const OUTPUTS = path.join(ROOT, "outputs");
const REPORTS = path.join(ROOT, "reports");
const IMAGE_BASE = "https://api.topazlabs.com/image/v1";

const CONFIGS = [
  {
    id: "transparency_upscale_4x",
    endpoint: "tool",
    model: "Transparency Upscale",
    outputWidth: 4096,
    outputHeight: 4096,
    estimatedCredits: 1,
    estimatedUsd: 0.12,
  },
  {
    id: "text_refine_4x",
    endpoint: "enhance",
    model: "Text Refine",
    outputWidth: 4096,
    outputHeight: 4096,
    estimatedCredits: 1,
    estimatedUsd: 0.12,
    extraFields: { face_enhancement: "false" },
  },
];

function loadDotEnvLocal() {
  const envPath = path.resolve(ROOT, "../../.env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const name = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[name]) process.env[name] = value;
  }
}

function normalizeWordingText(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function wordingMatches(required, detected) {
  const n = normalizeWordingText(required);
  if (!n) return true;
  return n === normalizeWordingText(detected);
}

function analyzeAlpha(pngBytes) {
  const png = PNG.sync.read(pngBytes);
  let fullTransparent = 0;
  let semiTransparent = 0;
  let opaque = 0;
  for (let i = 3; i < png.data.length; i += 4) {
    const a = png.data[i];
    if (a === 0) fullTransparent += 1;
    else if (a < 255) semiTransparent += 1;
    else opaque += 1;
  }
  const total = png.width * png.height;
  return {
    width: png.width,
    height: png.height,
    hasAlphaChannel: true,
    fullTransparent,
    semiTransparent,
    opaque,
    fullTransparentPct: (100 * fullTransparent) / total,
    semiTransparentPct: (100 * semiTransparent) / total,
    opaquePct: (100 * opaque) / total,
    opaqueBackgroundSuspected:
      fullTransparent === 0 && opaque / total > 0.85,
  };
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function submitTopaz({ apiKey, endpoint, model, outputWidth, outputHeight, extraFields, imageBytes, filename }) {
  const form = new FormData();
  form.append("model", model);
  form.append("output_width", String(outputWidth));
  form.append("output_height", String(outputHeight));
  form.append("output_format", "png");
  form.append("crop_to_fill", "false");
  if (extraFields) {
    for (const [k, v] of Object.entries(extraFields)) form.append(k, v);
  }
  form.append("image", new Blob([imageBytes], { type: "image/png" }), filename);

  const res = await fetch(`${IMAGE_BASE}/${endpoint}/async`, {
    method: "POST",
    headers: { "X-API-Key": apiKey },
    body: form,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const err = new Error(`Topaz submit ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function pollUntilDone(apiKey, processId, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${IMAGE_BASE}/status/${processId}`, {
      headers: { "X-API-Key": apiKey },
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`status ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    if (json.status === "Completed") return json;
    if (json.status === "Failed" || json.status === "Cancelled") {
      throw new Error(`job ${processId} ended as ${json.status}: ${JSON.stringify(json).slice(0, 400)}`);
    }
    await sleep(2500);
  }
  throw new Error(`job ${processId} timed out`);
}

async function downloadOutput(apiKey, processId, destPath) {
  const res = await fetch(`${IMAGE_BASE}/download/${processId}`, {
    headers: { "X-API-Key": apiKey },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`download meta ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  const url = json.url || json.download_url;
  if (!url) throw new Error(`no download url in ${JSON.stringify(json).slice(0, 300)}`);
  const imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error(`download bytes ${imgRes.status}`);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return { buf, meta: json };
}

async function ocrRequiredWording({ apiKey, model, imageBytes, requiredWording }) {
  if (!apiKey) {
    return {
      status: "skipped_no_openai_key",
      detectedText: null,
      confidence: null,
      matches: null,
    };
  }
  const b64 = imageBytes.toString("base64");
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: model || "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                'Read the exact wording printed in this apparel logo artwork. ' +
                'Return JSON only: {"detectedText": string, "confidence": number 0-100, "notes": string}. ' +
                `Required wording for comparison (do not invent): "${requiredWording}". ` +
                "If multiple text regions, concatenate in reading order with spaces.",
            },
            {
              type: "input_image",
              image_url: `data:image/png;base64,${b64}`,
            },
          ],
        },
      ],
      text: { format: { type: "json_object" } },
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    return {
      status: "ocr_error",
      error: JSON.stringify(json).slice(0, 400),
      detectedText: null,
      confidence: null,
      matches: null,
    };
  }
  const text =
    json.output_text ||
    json.output?.flatMap?.((o) => o.content || [])?.find?.((c) => c.type === "output_text")?.text ||
    "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { detectedText: text, confidence: null, notes: "unparsed" };
  }
  const detectedText = String(parsed.detectedText || "");
  return {
    status: "ok",
    detectedText,
    confidence: parsed.confidence ?? null,
    notes: parsed.notes ?? null,
    matches: wordingMatches(requiredWording, detectedText),
  };
}

function loadManifest() {
  return JSON.parse(fs.readFileSync(path.join(SOURCES, "manifest.json"), "utf8"));
}

async function runOne({ apiKey, source, config, openaiKey, openaiModel }) {
  const sourceBytes = fs.readFileSync(path.resolve(source.sourcePath));
  const sourceAlpha = analyzeAlpha(sourceBytes);
  const outName = `${source.category}__${config.id}.png`;
  const outPath = path.join(OUTPUTS, outName);
  const started = Date.now();
  let processId = null;
  let attempt = 0;
  let lastError = null;

  while (attempt < 2) {
    attempt += 1;
    try {
      const submitStarted = Date.now();
      const submitted = await submitTopaz({
        apiKey,
        endpoint: config.endpoint,
        model: config.model,
        outputWidth: config.outputWidth,
        outputHeight: config.outputHeight,
        extraFields: config.extraFields,
        imageBytes: sourceBytes,
        filename: path.basename(source.sourcePath),
      });
      processId = submitted.process_id;
      await pollUntilDone(apiKey, processId);
      const { buf, meta } = await downloadOutput(apiKey, processId, outPath);
      const latencyMs = Date.now() - started;
      const outputAlpha = analyzeAlpha(buf);
      const ocr = await ocrRequiredWording({
        apiKey: openaiKey,
        model: openaiModel,
        imageBytes: buf,
        requiredWording: source.requiredWording,
      });
      return {
        ok: true,
        source,
        config,
        processId,
        attempt,
        latencyMs,
        submitToCompleteMs: Date.now() - submitStarted,
        estimatedCredits: config.estimatedCredits,
        estimatedUsd: config.estimatedUsd,
        outputPath: outPath.replace(/\\/g, "/"),
        outputBytes: buf.length,
        sourceAlpha,
        outputAlpha,
        upscaleFactorWidth: outputAlpha.width / sourceAlpha.width,
        upscaleFactorHeight: outputAlpha.height / sourceAlpha.height,
        providerMeta: meta,
        ocr,
        provenanceExperimental: "provider_reconstruction_claimed",
        canvasNote:
          "4096 square reconstruction only; deterministic contain/pad to 3600x4200 is separate and not counted as reconstructed detail",
      };
    } catch (error) {
      lastError = {
        message: error instanceof Error ? error.message : String(error),
        status: error.status ?? null,
      };
      // One retry only for transient failures.
      if (attempt >= 2 || (error.status && error.status < 500 && error.status !== 429)) {
        break;
      }
      await sleep(3000);
    }
  }

  return {
    ok: false,
    source,
    config,
    processId,
    attempt,
    latencyMs: Date.now() - started,
    estimatedCredits: 0,
    estimatedUsd: 0,
    error: lastError,
  };
}

function scoreRun(run) {
  if (!run.ok) {
    return {
      resolution: "FAIL",
      exactWording: "FAIL",
      designFidelity: "FAIL",
      transparency: "FAIL",
      commercialPracticality: "FAIL",
      overall: "FAIL",
      notes: [run.error?.message || "provider failure"],
    };
  }
  const notes = [];
  const shortSide = Math.min(run.outputAlpha.width, run.outputAlpha.height);
  const resolution =
    shortSide >= 3240 && run.upscaleFactorWidth >= 3.5 ? "PASS" : shortSide >= 1200 ? "CONDITIONAL PASS" : "FAIL";
  if (resolution !== "PASS") notes.push(`shortSide=${shortSide}`);

  let exactWording = "CONDITIONAL PASS";
  if (run.ocr?.status === "ok") {
    exactWording = run.ocr.matches ? "PASS" : "FAIL";
    if (!run.ocr.matches) notes.push(`ocr detected=${JSON.stringify(run.ocr.detectedText)}`);
  } else {
    notes.push(`ocr ${run.ocr?.status || "missing"} — visual inspection required`);
  }

  // Design fidelity requires human inspection; harness marks CONDITIONAL.
  const designFidelity = "CONDITIONAL PASS";
  notes.push("design fidelity requires human side-by-side review of outputs/");

  let transparency = "FAIL";
  if (run.outputAlpha.fullTransparent > 0 && !run.outputAlpha.opaqueBackgroundSuspected) {
    transparency = "PASS";
  } else if (run.outputAlpha.hasAlphaChannel && run.outputAlpha.semiTransparent > 0) {
    transparency = "CONDITIONAL PASS";
    notes.push("alpha present but fully-transparent count is zero");
  } else {
    notes.push("transparency lost or opaque backdrop suspected");
  }

  const commercialPracticality =
    run.latencyMs < 180000 && run.estimatedUsd <= 0.25 ? "PASS" : "CONDITIONAL PASS";

  const hardFails = [resolution, exactWording, transparency].filter((s) => s === "FAIL");
  const overall = hardFails.length
    ? "FAIL"
    : [resolution, exactWording, designFidelity, transparency].includes("CONDITIONAL PASS")
      ? "CONDITIONAL PASS"
      : "PASS";

  return {
    resolution,
    exactWording,
    designFidelity,
    transparency,
    commercialPracticality,
    overall,
    notes,
  };
}

async function main() {
  loadDotEnvLocal();
  fs.mkdirSync(OUTPUTS, { recursive: true });
  fs.mkdirSync(REPORTS, { recursive: true });

  const apiKey = process.env.TOPAZ_API_KEY;
  if (!apiKey) {
    const report = {
      status: "blocked_missing_topaz_api_key",
      message:
        "Pre-flight spend gate passed (~$0.72–$1.08) but TOPAZ_API_KEY is not set. Add it to .env.local and re-run.",
      estimatedMaxUsd: 1.08,
      plannedCalls: CONFIGS.length * 3,
    };
    fs.writeFileSync(
      path.join(REPORTS, "blocked-missing-key.json"),
      JSON.stringify(report, null, 2),
    );
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  const manifest = loadManifest();
  const openaiKey = process.env.OPENAI_API_KEY || null;
  const openaiModel = process.env.OPENAI_EVALUATION_MODEL || "gpt-4.1-mini";

  const runs = [];
  let estimatedSpend = 0;

  for (const source of manifest.sources) {
    for (const config of CONFIGS) {
      console.error(`Running ${source.category} × ${config.id} ...`);
      const run = await runOne({ apiKey, source, config, openaiKey, openaiModel });
      run.scores = scoreRun(run);
      runs.push(run);
      estimatedSpend += run.estimatedUsd || 0;
      console.error(
        run.ok
          ? `  ok ${run.outputAlpha.width}x${run.outputAlpha.height} ${run.latencyMs}ms spend~$${estimatedSpend.toFixed(2)} overall=${run.scores.overall}`
          : `  FAIL ${run.error?.message}`,
      );
      if (estimatedSpend > 5) {
        console.error("Spend cap exceeded; stopping.");
        break;
      }
    }
    if (estimatedSpend > 5) break;
  }

  const report = {
    createdAt: new Date().toISOString(),
    provider: "topaz_labs_image_api",
    plannedConfigs: CONFIGS,
    paidCallsAttempted: runs.length,
    paidCallsSucceeded: runs.filter((r) => r.ok).length,
    estimatedSpendUsd: Number(estimatedSpend.toFixed(2)),
    runs: runs.map((r) => ({
      ...r,
      // never persist raw bytes
    })),
    decisionPendingHumanFidelityReview: true,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(REPORTS, `bakeoff-results-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(REPORTS, "bakeoff-results-latest.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportPath: reportPath.replace(/\\/g, "/"), estimatedSpendUsd: report.estimatedSpendUsd, succeeded: report.paidCallsSucceeded }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
