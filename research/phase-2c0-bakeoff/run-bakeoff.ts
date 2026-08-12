/**
 * Phase 2C0 — controlled concept quality / cost bake-off (research only).
 *
 * Hard caps paid OpenAI image requests. Does NOT enqueue generation jobs,
 * does NOT implement Phase 2C regeneration, does NOT touch Existing Artwork
 * or final-artwork providers.
 *
 * Usage (from repo root):
 *   $env:ALLOW_PAID_IMAGE_GENERATION="true"
 *   $env:PHASE2C0_CANDIDATE="A"   # or "B"
 *   npx tsx research/phase-2c0-bakeoff/run-bakeoff.ts
 *
 * Candidate A: gpt-image-1 + medium  (max 3 paid requests)
 * Candidate B: gpt-image-1-mini + medium (max 3 paid requests)
 *
 * Total Phase 2C0 budget across both candidates: 6.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

import { OpenAIConceptGenerationProvider } from "../../src/capabilities/providers/openai-concept-provider";
import { createPromptTranslationCapability } from "../../src/capabilities/prompt-translation";
import {
  evaluatePrintPaletteCompliance,
} from "../../src/capabilities/concept-evaluation/print-palette-compliance";
import type { RgbaImage } from "../../src/capabilities/final-artwork/raster-transform";
import { CONCEPT_DIRECTIONS } from "../../src/lib/domain/concept-directions";
import type { DesignBriefSnapshotContent } from "../../src/lib/domain/types";
import type { OpenAIConceptImageQuality } from "../../src/lib/config/openai-concept-image-quality";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(ROOT, ".tmp-phase2c0-bakeoff");
const HARD_CAP = 3;

const LIVE_HARLEY_DESCRIPTION =
  "A 2005 Harley Road Glide in black with silver trim and black tailpipes, featuring slight rise straight pull back bars, with a rider wearing a skull mask and helmet in black leather, and the Oakland Coliseum in the background, reflecting an Oakland Raiders theme. The rider is wearing a skull bask and helmet in black leather, with the oakland coliseum in the background Oakland Raiders theme.";

function loadDotEnvLocal() {
  const envPath = path.join(ROOT, ".env.local");
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

function harleyBrief(): DesignBriefSnapshotContent {
  return {
    productSummary: "T-shirt",
    designDescription: LIVE_HARLEY_DESCRIPTION,
    exactText: "",
    shirtColor: "Black",
    printPlacement: "full_back",
    preferredColors: ["White"],
    designStyle: null,
    additionalInstructions: null,
    audience: null,
    purpose: null,
    exclusions: null,
    deferredSections: [],
  };
}

function decodePng(bytes: Buffer): RgbaImage {
  const png = PNG.sync.read(bytes);
  return {
    width: png.width,
    height: png.height,
    data: Buffer.from(png.data),
  };
}

type Candidate = {
  id: "A" | "B";
  label: string;
  model: string;
  quality: OpenAIConceptImageQuality;
};

function resolveCandidate(): Candidate {
  const id = (process.env.PHASE2C0_CANDIDATE ?? "A").trim().toUpperCase();
  if (id === "B") {
    return {
      id: "B",
      label: "gpt-image-1-mini medium",
      model: "gpt-image-1-mini",
      quality: "medium",
    };
  }
  if (id === "A") {
    return {
      id: "A",
      label: "gpt-image-1 medium",
      model: "gpt-image-1",
      quality: "medium",
    };
  }
  throw new Error(`Unknown PHASE2C0_CANDIDATE="${id}". Use A or B.`);
}

async function main() {
  loadDotEnvLocal();

  if (process.env.ALLOW_PAID_IMAGE_GENERATION?.trim().toLowerCase() !== "true") {
    throw new Error(
      "Refusing to run: set ALLOW_PAID_IMAGE_GENERATION=true to arm this research script.",
    );
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const candidate = resolveCandidate();
  const outDir = path.join(OUT_DIR, `candidate-${candidate.id}`);
  fs.mkdirSync(outDir, { recursive: true });

  const brief = harleyBrief();
  const promptRequest = createPromptTranslationCapability().translate({
    approvedBrief: brief,
    regenerationPlan: null,
    targetConceptDirectionKey: null,
    revisionInstruction: null,
  });

  // Capture the three direction prompts via the real provider dialect
  // without spending credits, then submit exactly three paid calls with
  // NO transport retries.
  const capturedPrompts: string[] = [];
  const captureProvider = new OpenAIConceptGenerationProvider({
    apiKey: "sk-offline-capture",
    model: candidate.model,
    quality: candidate.quality,
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        prompt: string;
        quality: string;
        model: string;
      };
      capturedPrompts.push(body.prompt);
      if (body.quality !== candidate.quality) {
        throw new Error(`capture quality mismatch: ${body.quality}`);
      }
      if (body.model !== candidate.model) {
        throw new Error(`capture model mismatch: ${body.model}`);
      }
      return new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from("x").toString("base64") }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });

  await captureProvider.generate({
    designId: "phase2c0-harley",
    designBriefId: "phase2c0-brief",
    conceptCount: 3,
    prompt: promptRequest,
    idempotencyKey: `phase2c0:${candidate.id}:capture`,
  });

  if (capturedPrompts.length !== 3) {
    throw new Error(`Expected 3 prompts, got ${capturedPrompts.length}`);
  }

  console.log(
    JSON.stringify(
      {
        event: "phase2c0-start",
        candidate: candidate.id,
        label: candidate.label,
        model: candidate.model,
        quality: candidate.quality,
        hardCap: HARD_CAP,
        directions: CONCEPT_DIRECTIONS.slice(0, 3).map((d) => d.key),
      },
      null,
      2,
    ),
  );

  let paidRequests = 0;
  const results: Array<Record<string, unknown>> = [];

  for (let i = 0; i < 3; i += 1) {
    if (paidRequests >= HARD_CAP) {
      throw new Error("Hard cap reached before completing 3 directions — aborting.");
    }

    const direction = CONCEPT_DIRECTIONS[i]!;
    const prompt = capturedPrompts[i]!;
    paidRequests += 1;

    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: candidate.model,
        prompt,
        size: "1024x1024",
        quality: candidate.quality,
        background: "transparent",
        n: 1,
      }),
    });

    const providerRequestId =
      response.headers.get("x-request-id") ??
      response.headers.get("x-openai-request-id");

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(
        `Candidate ${candidate.id} direction ${direction.key}: unreadable response (status ${response.status}). STOP — no retries.`,
      );
    }

    if (!response.ok) {
      console.error(
        JSON.stringify({
          event: "phase2c0-failure",
          candidate: candidate.id,
          direction: direction.key,
          status: response.status,
          providerRequestId,
          // Never log full error bodies that might echo the prompt.
          errorType:
            payload && typeof payload === "object" && "error" in payload
              ? (payload as { error?: { type?: string; code?: string } }).error?.type
              : null,
        }),
      );
      throw new Error(
        `Candidate ${candidate.id} direction ${direction.key} failed with HTTP ${response.status}. STOP — no retries. Paid requests so far: ${paidRequests}.`,
      );
    }

    const data = (payload as { data?: Array<{ b64_json?: string }>; usage?: unknown })
      .data;
    const b64 = data?.[0]?.b64_json;
    if (!b64) {
      throw new Error(
        `Candidate ${candidate.id} direction ${direction.key}: missing image data. STOP.`,
      );
    }

    const bytes = Buffer.from(b64, "base64");
    const filename = `${direction.key}.png`;
    fs.writeFileSync(path.join(outDir, filename), bytes);

    const rgba = decodePng(bytes);
    const compliance = evaluatePrintPaletteCompliance({
      brief,
      image: rgba,
    });

    const usage =
      payload && typeof payload === "object" && "usage" in payload
        ? (payload as { usage: unknown }).usage
        : null;

    const row = {
      direction: direction.key,
      title: direction.title,
      model: candidate.model,
      quality: candidate.quality,
      providerRequestId,
      usage,
      paletteStatus: compliance.status,
      paletteCoverage: compliance.metrics.paletteCoverageFraction,
      garmentMatchingInk: compliance.metrics.garmentMatchingFraction,
      reasons: compliance.reasons,
      verdict:
        compliance.status === "pass"
          ? "PASS"
          : compliance.status === "warn"
            ? "WARN"
            : compliance.status === "fail"
              ? "FAIL"
              : compliance.status.toUpperCase(),
      file: filename,
      bytes: bytes.length,
    };
    results.push(row);
    console.log(JSON.stringify({ event: "phase2c0-concept", ...row }, null, 2));
  }

  const report = {
    candidate: candidate.id,
    label: candidate.label,
    model: candidate.model,
    quality: candidate.quality,
    paidRequests,
    hardCap: HARD_CAP,
    results,
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({ event: "phase2c0-complete", paidRequests, outDir }, null, 2),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
