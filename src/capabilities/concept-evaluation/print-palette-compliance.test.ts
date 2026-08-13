/**
 * Phase 2B — Deterministic print-palette / garment-contrast compliance tests.
 *
 * Zero network. Zero OpenAI / Topaz / paid providers. Synthetic fixtures only
 * except optional live Harley PNGs under `.tmp-phase2b-harley/` (gitignored).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { PNG } from "pngjs";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import type { DesignBriefSnapshotContent } from "@/lib/domain/types";
import {
  createConceptEvaluationCapability,
  PlaceholderConceptEvaluationProvider,
  type ConceptEvaluationProvider,
  type ConceptEvaluationResult,
} from "./index";
import { mergePrintPaletteCompliance } from "./merge-print-palette-compliance";
import {
  DEFAULT_PRINT_PALETTE_THRESHOLDS,
  evaluatePrintPaletteCompliance,
  pixelLuminance,
  type PrintPaletteComplianceStatus,
} from "./print-palette-compliance";
import { CONCEPT_EVALUATION_CRITERION_KEYS } from "./contracts";

const HARLEY_DIR = path.resolve(process.cwd(), ".tmp-phase2b-harley");

function blank(width: number, height: number): RgbaImage {
  return {
    width,
    height,
    data: Buffer.alloc(width * height * 4, 0),
  };
}

function fillRect(
  image: RgbaImage,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgba: [number, number, number, number],
) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const i = (y * image.width + x) * 4;
      image.data[i] = rgba[0];
      image.data[i + 1] = rgba[1];
      image.data[i + 2] = rgba[2];
      image.data[i + 3] = rgba[3];
    }
  }
}

/** Scatter `count` opaque pixels of a given color across the canvas. */
function scatter(
  image: RgbaImage,
  count: number,
  rgba: [number, number, number, number],
  seed = 1,
) {
  let s = seed;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
  for (let n = 0; n < count; n++) {
    const x = next() % image.width;
    const y = next() % image.height;
    const i = (y * image.width + x) * 4;
    image.data[i] = rgba[0];
    image.data[i + 1] = rgba[1];
    image.data[i + 2] = rgba[2];
    image.data[i + 3] = rgba[3];
  }
}

/**
 * Build an image whose visible pixels follow target light/dark fractions
 * (alpha-weighted). Used to pin Harley-like distributions without shipping
 * customer assets.
 */
function distributionFixture(opts: {
  lightFraction: number;
  darkFraction: number;
  size?: number;
}): RgbaImage {
  const size = opts.size ?? 100;
  const image = blank(size, size);
  const total = size * size;
  const lightN = Math.round(total * opts.lightFraction);
  const darkN = Math.round(total * opts.darkFraction);
  const midN = Math.max(0, total - lightN - darkN);
  let i = 0;
  const put = (rgb: [number, number, number], n: number) => {
    for (let k = 0; k < n; k++) {
      const idx = i * 4;
      image.data[idx] = rgb[0];
      image.data[idx + 1] = rgb[1];
      image.data[idx + 2] = rgb[2];
      image.data[idx + 3] = 255;
      i++;
    }
  };
  put([250, 250, 250], lightN);
  put([128, 128, 128], midN);
  put([10, 10, 10], darkN);
  return image;
}

function hardWhiteOnBlackBrief(
  overrides: Partial<DesignBriefSnapshotContent> = {},
): DesignBriefSnapshotContent {
  return {
    productSummary: "T-shirts",
    designDescription:
      "A black 2005 Harley Road Glide with black leather and black helmet",
    exactText: "",
    shirtColor: "Black",
    printPlacement: "full_back",
    preferredColors: ["White"],
    designStyle: null,
    exclusions: null,
    deferredSections: [],
    additionalInstructions: null,
    audience: null,
    purpose: null,
    ...overrides,
  };
}

function softWhiteBrief(): DesignBriefSnapshotContent {
  return hardWhiteOnBlackBrief({
    designDescription: "A friendly bear mascot",
    preferredColors: ["White"],
  });
}

function noPaletteBrief(): DesignBriefSnapshotContent {
  return hardWhiteOnBlackBrief({
    preferredColors: [],
    designDescription: "A friendly bear mascot",
  });
}

function decodePngFile(filePath: string): RgbaImage {
  const png = PNG.sync.read(readFileSync(filePath));
  return {
    width: png.width,
    height: png.height,
    data: Buffer.from(png.data),
  };
}

describe("Phase 2B print-palette compliance — synthetic matrix", () => {
  it("A: black garment + pure white artwork → PASS", () => {
    const image = blank(64, 64);
    fillRect(image, 8, 8, 48, 48, [255, 255, 255, 255]);
    const result = evaluatePrintPaletteCompliance({
      image,
      brief: hardWhiteOnBlackBrief(),
    });
    assert.equal(result.status, "pass");
    assert.ok(result.metrics.paletteCoverageFraction > 0.9);
    assert.ok(result.metrics.garmentMatchingFraction < 0.05);
  });

  it("B: white artwork with small dark AA/shading → PASS", () => {
    const image = blank(64, 64);
    fillRect(image, 8, 8, 48, 48, [245, 245, 245, 255]);
    // ~3% dark accents
    scatter(image, Math.round(64 * 64 * 0.03), [20, 20, 20, 255], 7);
    const result = evaluatePrintPaletteCompliance({
      image,
      brief: hardWhiteOnBlackBrief(),
    });
    assert.equal(result.status, "pass");
  });

  it("C: white artwork with moderate dark accents → WARN", () => {
    const image = blank(100, 100);
    fillRect(image, 0, 0, 100, 100, [250, 250, 250, 255]);
    // Contiguous 12% dark block — above WARN (8%), below FAIL (35%)
    fillRect(image, 0, 0, 100, 12, [15, 15, 15, 255]);
    const result = evaluatePrintPaletteCompliance({
      image,
      brief: hardWhiteOnBlackBrief(),
    });
    assert.equal(
      result.status,
      "warn",
      `metrics=${JSON.stringify(result.metrics)}`,
    );
    assert.ok(
      result.reasons.includes("notable_non_palette_accents") ||
        result.reasons.includes("hard_palette_not_dominant"),
    );
  });

  it("D: majority black artwork on black garment → FAIL", () => {
    const image = blank(64, 64);
    fillRect(image, 0, 0, 64, 64, [12, 12, 12, 255]);
    fillRect(image, 20, 20, 10, 10, [255, 255, 255, 255]);
    const result = evaluatePrintPaletteCompliance({
      image,
      brief: hardWhiteOnBlackBrief(),
    });
    assert.equal(result.status, "fail");
    assert.ok(
      result.reasons.includes("excessive_garment_matching_ink") ||
        result.reasons.includes("hard_palette_not_dominant"),
    );
  });

  it("E: white garment + pure black artwork (hard black palette) → PASS", () => {
    const image = blank(64, 64);
    fillRect(image, 8, 8, 48, 48, [0, 0, 0, 255]);
    const result = evaluatePrintPaletteCompliance({
      image,
      brief: hardWhiteOnBlackBrief({
        shirtColor: "White",
        preferredColors: ["Black"],
        designDescription: "A white motorcycle with white leather accents",
      }),
    });
    assert.equal(result.status, "pass");
  });

  it("F: white garment + mostly white artwork with hard black palette → FAIL", () => {
    const image = blank(64, 64);
    fillRect(image, 0, 0, 64, 64, [250, 250, 250, 255]);
    fillRect(image, 28, 28, 8, 8, [0, 0, 0, 255]);
    const result = evaluatePrintPaletteCompliance({
      image,
      brief: hardWhiteOnBlackBrief({
        shirtColor: "White",
        preferredColors: ["Black"],
        designDescription: "A white subject that must print in black ink",
      }),
    });
    assert.equal(result.status, "fail");
  });

  it("G: dark navy garment + white artwork → PASS", () => {
    const image = blank(64, 64);
    fillRect(image, 8, 8, 48, 48, [255, 255, 255, 255]);
    const result = evaluatePrintPaletteCompliance({
      image,
      brief: hardWhiteOnBlackBrief({
        shirtColor: "Navy",
        designDescription: "A navy blue motorcycle scene rendered for print",
      }),
    });
    assert.equal(result.status, "pass");
    assert.equal(result.metrics.garmentClass, "dark");
  });

  it("H: soft preferred palette only → no hard FAIL", () => {
    const image = blank(64, 64);
    fillRect(image, 0, 0, 64, 64, [10, 10, 10, 255]);
    const result = evaluatePrintPaletteCompliance({
      image,
      brief: softWhiteBrief(),
    });
    assert.notEqual(result.status, "fail");
    assert.ok(
      result.status === "warn" || result.status === "pass",
      `soft must not hard-fail, got ${result.status}`,
    );
    assert.ok(result.reasons.includes("soft_preference_only"));
  });

  it("I: no palette → not_applicable", () => {
    const image = blank(32, 32);
    fillRect(image, 0, 0, 32, 32, [0, 0, 0, 255]);
    const result = evaluatePrintPaletteCompliance({
      image,
      brief: noPaletteBrief(),
    });
    assert.equal(result.status, "not_applicable");
    assert.ok(result.reasons.includes("no_palette_gate"));
  });

  it("J: transparent empty image → fail/invalid diagnostic", () => {
    const image = blank(32, 32);
    const result = evaluatePrintPaletteCompliance({
      image,
      brief: hardWhiteOnBlackBrief(),
    });
    assert.equal(result.status, "fail");
    assert.ok(result.reasons.includes("low_visible_content"));
  });

  it("K: semi-transparent antialiased edge pixels are alpha-weighted", () => {
    const image = blank(40, 40);
    // Opaque white core
    fillRect(image, 10, 10, 20, 20, [255, 255, 255, 255]);
    // Semi-transparent dark fringe — should not dominate like opaque dark
    fillRect(image, 8, 8, 24, 2, [0, 0, 0, 40]);
    fillRect(image, 8, 30, 24, 2, [0, 0, 0, 40]);
    const result = evaluatePrintPaletteCompliance({
      image,
      brief: hardWhiteOnBlackBrief(),
    });
    assert.equal(result.status, "pass");
    assert.ok(result.metrics.garmentMatchingFraction < 0.08);
  });

  it("L: metadata says White but pixels are black → FAIL", () => {
    const image = blank(48, 48);
    fillRect(image, 0, 0, 48, 48, [5, 5, 5, 255]);
    const result = evaluatePrintPaletteCompliance({
      image,
      brief: hardWhiteOnBlackBrief({
        preferredColors: ["White"],
      }),
    });
    assert.equal(result.status, "fail");
    // Proves pixels win over preferredColors metadata alone
    assert.ok(result.metrics.paletteCoverageFraction < 0.2);
  });

  it("N: light gray (not pure #FFFFFF) on black garment is not penalized", () => {
    const image = blank(64, 64);
    fillRect(image, 8, 8, 48, 48, [220, 220, 220, 255]);
    const result = evaluatePrintPaletteCompliance({
      image,
      brief: hardWhiteOnBlackBrief(),
    });
    assert.equal(result.status, "pass");
    assert.ok(result.metrics.paletteCoverageFraction > 0.9);
  });
});

describe("Phase 2B — vision cannot override deterministic hard FAIL", () => {
  it("M: merge forces color_palette failed even when vision passed", () => {
    const visionOk: ConceptEvaluationResult = {
      overallScore: 88,
      passed: true,
      confidence: 90,
      status: "passed",
      criteria: CONCEPT_EVALUATION_CRITERION_KEYS.map((key) => ({
        key,
        score: 90,
        passed: true,
        confidence: 90,
        notes: key === "color_palette" ? "looks white enough" : null,
      })),
      warnings: [],
      recommendations: [],
      missingRequirements: [],
      matchedRequirements: ["color palette"],
      providerMetadata: { mode: "openai_vision" },
    };

    const image = blank(32, 32);
    fillRect(image, 0, 0, 32, 32, [8, 8, 8, 255]);
    const compliance = evaluatePrintPaletteCompliance({
      image,
      brief: hardWhiteOnBlackBrief(),
    });
    assert.equal(compliance.status, "fail");

    const merged = mergePrintPaletteCompliance(visionOk, compliance);
    const color = merged.criteria.find((c) => c.key === "color_palette");
    assert.equal(color?.passed, false);
    assert.match(color?.notes ?? "", /deterministic_print_palette_fail/);
    // Phase 2B: overall lifecycle status unchanged
    assert.equal(merged.status, "passed");
    assert.equal(merged.passed, true);
    assert.equal(merged.printPaletteCompliance?.status, "fail");
  });
});

describe("Phase 2B — threshold sensitivity", () => {
  it("N: Soft-like dark distribution stays FAIL across a reasonable threshold band", () => {
    const softLike = distributionFixture({
      lightFraction: 0.2,
      darkFraction: 0.65,
    });
    for (const failMatching of [0.3, 0.35, 0.4, 0.45]) {
      const result = evaluatePrintPaletteCompliance({
        image: softLike,
        brief: hardWhiteOnBlackBrief(),
        thresholds: { failGarmentMatching: failMatching },
      });
      assert.equal(
        result.status,
        "fail",
        `Soft-like must FAIL at failGarmentMatching=${failMatching}`,
      );
    }
  });

  it("pure white stays PASS when WARN threshold moves", () => {
    const image = blank(48, 48);
    fillRect(image, 4, 4, 40, 40, [255, 255, 255, 255]);
    for (const warnMatching of [0.05, 0.08, 0.12]) {
      const result = evaluatePrintPaletteCompliance({
        image,
        brief: hardWhiteOnBlackBrief(),
        thresholds: { warnGarmentMatching: warnMatching },
      });
      assert.equal(result.status, "pass");
    }
  });

  it("Bold-like ~11% dark sits near WARN boundary", () => {
    const boldLike = distributionFixture({
      lightFraction: 0.78,
      darkFraction: 0.11,
    });
    const atDefault = evaluatePrintPaletteCompliance({
      image: boldLike,
      brief: hardWhiteOnBlackBrief(),
    });
    assert.equal(atDefault.status, "warn");

    const stricter = evaluatePrintPaletteCompliance({
      image: boldLike,
      brief: hardWhiteOnBlackBrief(),
      thresholds: { warnGarmentMatching: 0.15 },
    });
    assert.equal(stricter.status, "pass");

    const looserFail = evaluatePrintPaletteCompliance({
      image: boldLike,
      brief: hardWhiteOnBlackBrief(),
      thresholds: { failGarmentMatching: 0.1 },
    });
    assert.equal(looserFail.status, "fail");
  });
});

describe("Phase 2B — Harley live regression (optional local PNGs)", () => {
  const files = {
    bold: path.join(HARLEY_DIR, "bold_direct.png"),
    soft: path.join(HARLEY_DIR, "soft_illustrated.png"),
    minimal: path.join(HARLEY_DIR, "minimal_badge.png"),
  };
  const present =
    existsSync(files.bold) && existsSync(files.soft) && existsSync(files.minimal);

  it(
    "O/P/Q: Soft FAIL, Bold WARN, Minimal PASS (or WARN) on live rasters",
    { skip: !present },
    () => {
      const brief = hardWhiteOnBlackBrief();

      const soft = evaluatePrintPaletteCompliance({
        image: decodePngFile(files.soft),
        brief,
      });
      assert.equal(
        soft.status,
        "fail",
        `Soft metrics=${JSON.stringify(soft.metrics)}`,
      );
      assert.ok(soft.metrics.garmentMatchingFraction > 0.5);

      const bold = evaluatePrintPaletteCompliance({
        image: decodePngFile(files.bold),
        brief,
      });
      assert.ok(
        bold.status === "warn" || bold.status === "fail",
        `Bold expected WARN|FAIL, got ${bold.status} metrics=${JSON.stringify(bold.metrics)}`,
      );
      // Soft must be clearly worse than Bold on garment-matching ink
      assert.ok(
        soft.metrics.garmentMatchingFraction >
          bold.metrics.garmentMatchingFraction,
      );

      const minimal = evaluatePrintPaletteCompliance({
        image: decodePngFile(files.minimal),
        brief,
      });
      assert.notEqual(
        minimal.status,
        "fail",
        `Minimal must not FAIL on light art; metrics=${JSON.stringify(minimal.metrics)}`,
      );
      assert.ok(
        minimal.status === "pass" || minimal.status === "warn",
        `Minimal got ${minimal.status}`,
      );
      assert.ok(minimal.metrics.paletteCoverageFraction > 0.85);
      assert.ok(minimal.metrics.garmentMatchingFraction < 0.05);
    },
  );

  it("Harley-like synthetic distributions pin Soft/Bold/Minimal classes", () => {
    const brief = hardWhiteOnBlackBrief();
    const soft = evaluatePrintPaletteCompliance({
      image: distributionFixture({ lightFraction: 0.21, darkFraction: 0.65 }),
      brief,
    });
    const bold = evaluatePrintPaletteCompliance({
      image: distributionFixture({ lightFraction: 0.78, darkFraction: 0.11 }),
      brief,
    });
    const minimal = evaluatePrintPaletteCompliance({
      image: distributionFixture({ lightFraction: 0.95, darkFraction: 0.002 }),
      brief,
    });
    assert.equal(soft.status, "fail");
    assert.equal(bold.status, "warn");
    assert.equal(minimal.status, "pass");
  });
});

describe("Phase 2B — capability integration + Existing Artwork unaffected", () => {
  it("capability attaches printPaletteCompliance without changing overall status", async () => {
    const provider: ConceptEvaluationProvider = {
      providerKey: "test_vision",
      async evaluate(): Promise<ConceptEvaluationResult> {
        return {
          overallScore: 80,
          passed: true,
          confidence: 80,
          status: "passed",
          criteria: CONCEPT_EVALUATION_CRITERION_KEYS.map((key) => ({
            key,
            score: 80,
            passed: true,
            confidence: 80,
            notes: null,
          })),
          warnings: [],
          recommendations: [],
          missingRequirements: [],
          matchedRequirements: [],
          providerMetadata: { mode: "test" },
        };
      },
    };
    const capability = createConceptEvaluationCapability(provider);
    const image = blank(32, 32);
    fillRect(image, 0, 0, 32, 32, [0, 0, 0, 255]);
    const result = await capability.evaluate({
      brief: hardWhiteOnBlackBrief(),
      concept: { title: "X", summary: "Y", placeholderLabel: "Z" },
      assets: [],
      idempotencyKey: "k",
      image,
    });
    assert.equal(result.printPaletteCompliance?.status, "fail");
    assert.equal(result.status, "passed"); // lifecycle unchanged
    const persisted = capability.toPersistedEvaluation(result);
    assert.equal(persisted.evaluation.printPaletteCompliance?.status, "fail");
    assert.equal(persisted.evaluationStatus, "passed");
  });

  it("placeholder evaluation without image is not_applicable for pixels", async () => {
    const capability = createConceptEvaluationCapability(
      new PlaceholderConceptEvaluationProvider(),
    );
    const result = await capability.evaluate({
      brief: hardWhiteOnBlackBrief(),
      concept: { title: "T", summary: "S", placeholderLabel: "P" },
      assets: [],
      idempotencyKey: "k2",
    });
    assert.equal(result.printPaletteCompliance?.status, "not_applicable");
    assert.ok(
      result.printPaletteCompliance?.reasons.includes("pixels_unavailable"),
    );
  });

  it("R: artwork-preparation does not import print-palette-compliance", async () => {
    const fs = await import("node:fs/promises");
    const prepDir = path.resolve(
      process.cwd(),
      "src/capabilities/artwork-preparation",
    );
    const files = await fs.readdir(prepDir);
    for (const file of files) {
      if (!file.endsWith(".ts")) continue;
      const text = await fs.readFile(path.join(prepDir, file), "utf8");
      assert.doesNotMatch(
        text,
        /print-palette-compliance/,
        `${file} must not depend on Phase 2B concept palette gate`,
      );
    }
  });

  it("S: evaluatePrintPaletteCompliance performs zero network calls", () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network forbidden in Phase 2B validator");
    }) as typeof fetch;
    try {
      const image = blank(16, 16);
      fillRect(image, 0, 0, 16, 16, [255, 255, 255, 255]);
      const result = evaluatePrintPaletteCompliance({
        image,
        brief: hardWhiteOnBlackBrief(),
      });
      assert.equal(result.status, "pass");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Phase 2B — luminance helper sanity", () => {
  it("documents Rec.601 thresholds used by the gate", () => {
    assert.ok(pixelLuminance(255, 255, 255) > 0.99);
    assert.ok(pixelLuminance(0, 0, 0) < 0.01);
    assert.ok(pixelLuminance(220, 220, 220) >= 0.7);
    assert.equal(DEFAULT_PRINT_PALETTE_THRESHOLDS.failGarmentMatching, 0.35);
  });
});

// Silence unused-type import if node test strips it
void (null as unknown as PrintPaletteComplianceStatus);
