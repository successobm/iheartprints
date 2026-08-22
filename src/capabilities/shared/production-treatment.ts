/**
 * Print'em All Phase 2 — THE PRODUCTION TREATMENT AUTHORITY.
 *
 * The one question this module answers: *which apparel-raster production
 * REPRESENTATION is this project's plate being made as, and with exactly what
 * settings?*
 *
 * WHY A SECOND REPRESENTATION EXISTS AT ALL
 *
 * Phase 1 made the confirmed physical size knowable before provider spend.
 * That immediately produced a class of honest refusals: a prepared upload
 * whose visible artwork is 562px wide, asked to print 10.5 inches at 300 PPI,
 * needs 3150px — 5.6x — and the reconstruction provider's proven ceiling is
 * 4x. Standard raster therefore refuses it, for free, before dispatch
 * (`resolveReconstructionRequest`), and the customer is told the artwork can
 * only print at about 7.5 inches.
 *
 * That refusal is correct FOR CONTINUOUS TONE. It is not the only way to put
 * that artwork on a garment at 10.5 inches. A DTF halftone is a different
 * production representation with different — and independently measurable —
 * requirements: the printed dot geometry is GENERATED at final size, so it
 * never needs reconstructed source detail, and the tonal information the
 * screen consumes is bounded by the screen's own frequency (LPI), not by
 * 300 PPI. See `halftone-screen.ts` for the arithmetic and
 * `print-validation-capability.ts` for the checks that prove it.
 *
 * WHAT THIS IS NOT
 *
 * Not a loophole, and not a fallback. Nothing in this module may ever be
 * reached by "standard validation failed, try the other one". A treatment is
 * DURABLE, EXPLICIT AUTHORITY — recorded because a human chose it — and Phase
 * 2 restricts that choice to internal Print'em All operators. There is no
 * automatic selection, public or otherwise.
 *
 * It is also not a claim about print quality. Halftoning solves tonal
 * representation and garment integration. It cannot restore semantic detail
 * (blurred subjects, unreadable text, malformed AI artifacts), and nothing
 * here may be worded as though it could.
 *
 * Pure — no repository, no capability, no I/O, no clock.
 */

/**
 * The persisted VOCABULARY — `ProductionTreatment`, `HalftoneSettings`,
 * `GarmentColor`, the dot/angle value sets, the numeric bounds, and their
 * fail-closed readers — lives in `lib/domain/types.ts`, alongside
 * `GarmentSizeClass` and `StoredRequestedProductionOutput`.
 *
 * Not an arbitrary split. `lib/db` persists and reads these values and never
 * depends on `capabilities`, so the shapes have to sit below that line. What
 * lives HERE is everything the database has no opinion about: which value is
 * recommended, how an operator request becomes a legal setting, what makes two
 * settings the same production intent, and when the treatment may be offered
 * at all.
 */
export {
  DEFAULT_PRODUCTION_TREATMENT,
  STANDARD_RASTER_TREATMENT_KEY,
  HALFTONE_DOT_SHAPES,
  HALFTONE_SCREEN_ANGLES,
  MAX_HALFTONE_CHOKE_PX,
  MAX_HALFTONE_LPI,
  MAX_HALFTONE_MIDTONE,
  MIN_HALFTONE_CHOKE_PX,
  MIN_HALFTONE_LPI,
  MIN_HALFTONE_MIDTONE,
  PRODUCTION_TREATMENTS,
  isProductionTreatment,
  readProductionTreatment,
} from "@/lib/domain/types";
export type {
  GarmentColor,
  HalftoneDotShape,
  HalftoneScreenAngle,
  HalftoneSettings,
  ProductionTreatment,
} from "@/lib/domain/types";

import {
  STANDARD_RASTER_TREATMENT_KEY,
  HALFTONE_DOT_SHAPES,
  type ProductionTreatment,
  HALFTONE_SCREEN_ANGLES,
  MAX_HALFTONE_CHOKE_PX,
  MAX_HALFTONE_LPI,
  MAX_HALFTONE_MIDTONE,
  MIN_HALFTONE_CHOKE_PX,
  MIN_HALFTONE_LPI,
  MIN_HALFTONE_MIDTONE,
  type GarmentColor,
  type HalftoneDotShape,
  type HalftoneScreenAngle,
  type HalftoneSettings,
} from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Halftone settings (Goals 6-10, 12, 14, 16)
// ---------------------------------------------------------------------------

/**
 * Supported screen angles, in degrees.
 *
 * A PRODUCTION STARTING POINT, NOT A TRUTH. These two are offered because
 * they are the two a single-colour garment screen actually has reason to
 * choose between, and because the engine genuinely rotates the screen
 * geometry for both — an angle control with no measurable effect on output
 * pixels would be worse than no control at all (see the `22.5 !== 45` test).
 */
/**
 * The initial operator default angle.
 *
 * 45 degrees, because for a SINGLE-colour screen (which this is — we are not
 * separating channels and there is no rotated set to avoid moire against) a
 * diagonal dot lattice is the least conspicuous to human vision, and most
 * garment artwork carries strong horizontal/vertical structure that an
 * orthogonal-ish screen beats against. 22.5 degrees is offered for artwork
 * whose own dominant structure is diagonal.
 *
 * Labelled an operator default rather than an industry guarantee: no physical
 * print test has yet been run through this engine.
 */
export const DEFAULT_HALFTONE_ANGLE_DEG: HalftoneScreenAngle = 45;

/**
 * The bounded LPI band this build supports.
 *
 * WHY A BAND AND NOT A NUMBER. There is no universally correct DTF line
 * frequency, and pretending otherwise would be inventing a standard. External
 * evidence genuinely varies: the market tool most often cited exposes roughly
 * 15-55 LPI, while other DTF guidance recommends 25-50 or 35-50 depending on
 * image size and printer quality. So the product ships a conservative band an
 * operator moves inside, and records which value produced each plate.
 *
 * The band's own bounds are ours, not theirs, and they are justified against
 * OUR 300 PPI raster (see `DEFAULT_HALFTONE_LPI`).
 */
/**
 * The initial operator default line frequency.
 *
 * 35 LPI, chosen from this pipeline's own arithmetic rather than from
 * another product's UI:
 *
 *   - At the 300 PPI production target, 35 LPI is 300/35 = 8.571 output
 *     pixels per halftone cell — about 73 pixels of area per cell, so the
 *     screen can render roughly 73 distinguishable coverage steps. That is
 *     enough for visually smooth gradation. At the 55 LPI top of the band a
 *     cell is 5.45px (about 30 steps), which is visibly coarser tonally even
 *     though the dots themselves are finer.
 *   - A 35 LPI screen samples tone 35 times per inch, so it asks the prepared
 *     source for 35 PPI of tonal information. The live Print'em All fixture
 *     carries 562 visible pixels across 10.5 inches — 53.5 PPI — so a 35 LPI
 *     screen is backed by real source tone with margin, while a 55 LPI screen
 *     would be asking for slightly more than the file has. That relationship
 *     is not a rule of thumb here; it is the `halftone_tonal_sufficiency`
 *     check.
 *   - Larger dots are also the safer starting point for the FIRST physical
 *     DTF tests, which have not happened yet.
 *
 * An initial operator default. Not a Constitution-level guarantee, and not a
 * claim about any particular printer, film, powder, or RIP.
 */
export const DEFAULT_HALFTONE_LPI = 35;

export const DEFAULT_HALFTONE_MIDTONE = 1;

/**
 * Edge choke bounds, in OUTPUT pixels.
 *
 * Small and explicit on purpose (Goal 12). This is a narrow edge cleanup for
 * feathered alpha that would otherwise screen into a scatter of sub-printable
 * dots around the artwork — it is NOT a white-underbase editor, and the
 * default is 0 so no plate ever silently loses an edge pixel nobody asked to
 * remove.
 */
export const DEFAULT_HALFTONE_CHOKE_PX = 0;

/**
 * Below this radius, in OUTPUT pixels, a halftone dot is not something a DTF
 * process reproduces — it is a speck that becomes haze or drops out
 * unpredictably.
 *
 * A PRODUCTION POLICY, which is why it lives here rather than inside the
 * engine: the engine reads it to describe the screen it resolved, and
 * authoritative Print Validation reads it to judge that screen. Two consumers
 * on opposite sides of the pipeline must be reading one number, not two
 * copies that can drift.
 *
 * Never applied as a per-pixel fixup. With the engine's coverage floor the
 * SMALLEST dot a screen can emit is fixed by its cell size, so this is a
 * property of the resolved screen — checked once, before any pixel is
 * written, rather than patched afterwards.
 */
export const MIN_PRINTABLE_DOT_RADIUS_PX = 0.75;

/**
 * The engine identity these settings were interpreted by.
 *
 * Bumped whenever a change would produce different output pixels from
 * identical settings. Persisted with every plate, so "reproduce this exact
 * result" is answerable rather than approximately answerable, and so a plate
 * produced by an older engine is recognizable as such instead of silently
 * assumed current.
 */
export const HALFTONE_ALGORITHM_VERSION = "iheartprints_halftone_am_v1";

/**
 * The durable treatment decision for one project: which representation, plus
 * the settings when the representation has any.
 */
export type ProductionTreatmentSelection =
  | { treatment: "standard_raster" }
  | { treatment: "halftone_dtf"; halftone: HalftoneSettings };

// ---------------------------------------------------------------------------
// Garment colour resolution (Goal 4)
// ---------------------------------------------------------------------------

/**
 * The apparel colour table.
 *
 * NOT a second colour field (Goal 4). `TShirtDesignBrief.shirtColor` remains
 * the one authority for WHICH colour the garment is; this table only answers
 * "what RGB is that, for tonal arithmetic and preview compositing".
 *
 * Values are ordinary blank-garment approximations, not Pantone matches, and
 * are never presented to anyone as colour-accurate. Their only production
 * role is to place the garment on the tonal axis so the screen knows which
 * end of the range reveals fabric — an approximation is entirely sufficient
 * for that, and a claim of accuracy would not be.
 */
const GARMENT_COLOR_TABLE: Record<string, string> = {
  black: "#000000",
  white: "#FFFFFF",
  navy: "#1B2A44",
  "navy blue": "#1B2A44",
  royal: "#1F3FAF",
  "royal blue": "#1F3FAF",
  red: "#B22234",
  maroon: "#5C1A2B",
  forest: "#1E4620",
  "forest green": "#1E4620",
  green: "#2E7D32",
  kelly: "#2E7D32",
  "kelly green": "#2E7D32",
  charcoal: "#3B3B3B",
  "dark heather": "#4A4A4A",
  heather: "#9AA0A6",
  "sport grey": "#9AA0A6",
  "sport gray": "#9AA0A6",
  grey: "#9AA0A6",
  gray: "#9AA0A6",
  "ash grey": "#C8C8C8",
  "ash gray": "#C8C8C8",
  ash: "#C8C8C8",
  sand: "#D8CBB4",
  natural: "#E4DACA",
  cream: "#F2EADF",
  "light blue": "#A7C6DD",
  "carolina blue": "#7BAFD4",
  purple: "#4B2E83",
  orange: "#D9531E",
  gold: "#D4A017",
  yellow: "#F2D024",
  pink: "#E8A0BF",
  brown: "#5B4636",
};

const HEX_PATTERN = /^#?([0-9a-fA-F]{6})$/;

/**
 * Resolves the brief's stated garment colour into production RGB.
 *
 * Returns `null` — never a guess — when the stated colour cannot be resolved.
 * A halftone screen's whole tonal reference point is the garment, so
 * substituting an arbitrary colour for an unrecognized one would silently
 * decide which parts of the customer's artwork drop out. Unresolvable means
 * the treatment is not offered until somebody states a colour it can use, and
 * an exact `#RRGGBB` is always accepted for a garment the table has no name
 * for.
 */
export function resolveGarmentColor(
  shirtColor: string | null | undefined,
): GarmentColor | null {
  if (typeof shirtColor !== "string") return null;
  const label = shirtColor.trim();
  if (!label) return null;

  const hexMatch = HEX_PATTERN.exec(label);
  const hex = hexMatch
    ? `#${hexMatch[1].toUpperCase()}`
    : GARMENT_COLOR_TABLE[label.toLowerCase().replace(/\s+/g, " ")];
  if (!hex) return null;

  return {
    label,
    hex,
    rgb: {
      r: Number.parseInt(hex.slice(1, 3), 16),
      g: Number.parseInt(hex.slice(3, 5), 16),
      b: Number.parseInt(hex.slice(5, 7), 16),
    },
  };
}

// ---------------------------------------------------------------------------
// Settings normalization + canonical identity (Goals 15, 16)
// ---------------------------------------------------------------------------

export interface HalftoneSettingsRequest {
  lpi?: number | null;
  angleDeg?: number | null;
  dotShape?: string | null;
  midtone?: number | null;
  chokePx?: number | null;
}

/** The recommended starting point an operator's "Reset" returns to (Goal 14). */
export function recommendedHalftoneSettings(garment: GarmentColor): HalftoneSettings {
  return {
    lpi: DEFAULT_HALFTONE_LPI,
    angleDeg: DEFAULT_HALFTONE_ANGLE_DEG,
    dotShape: "round",
    midtone: DEFAULT_HALFTONE_MIDTONE,
    chokePx: DEFAULT_HALFTONE_CHOKE_PX,
    garment,
    algorithmVersion: HALFTONE_ALGORITHM_VERSION,
  };
}

/**
 * Normalizes an operator request into settings the engine can be held to.
 *
 * REFUSES out-of-band values rather than clamping them, for the same reason
 * `normalizeConfirmableWidth` does: a clamp records a setting the operator did
 * not choose, and every one of these numbers is persisted as the explanation
 * for how a physical plate was made. An operator who asks for 90 LPI is told
 * the band; they are not quietly given 55 and left to wonder why the print
 * does not look like what they asked for.
 *
 * Absent fields take the recommended default — that is a starting point being
 * offered, not a value being overridden.
 */
export function normalizeHalftoneSettings(
  request: HalftoneSettingsRequest,
  garment: GarmentColor,
): HalftoneSettings | null {
  const base = recommendedHalftoneSettings(garment);

  const lpi = request.lpi ?? base.lpi;
  if (!Number.isInteger(lpi) || lpi < MIN_HALFTONE_LPI || lpi > MAX_HALFTONE_LPI) {
    return null;
  }

  const angleDeg = request.angleDeg ?? base.angleDeg;
  if (!(HALFTONE_SCREEN_ANGLES as readonly number[]).includes(angleDeg)) return null;

  const dotShape = request.dotShape ?? base.dotShape;
  if (!(HALFTONE_DOT_SHAPES as readonly string[]).includes(dotShape)) return null;

  const midtone = request.midtone ?? base.midtone;
  if (
    !Number.isFinite(midtone) ||
    midtone < MIN_HALFTONE_MIDTONE ||
    midtone > MAX_HALFTONE_MIDTONE
  ) {
    return null;
  }

  const chokePx = request.chokePx ?? base.chokePx;
  if (
    !Number.isInteger(chokePx) ||
    chokePx < MIN_HALFTONE_CHOKE_PX ||
    chokePx > MAX_HALFTONE_CHOKE_PX
  ) {
    return null;
  }

  return {
    lpi,
    angleDeg: angleDeg as HalftoneScreenAngle,
    dotShape: dotShape as HalftoneDotShape,
    // Rounded to the precision the canonical key records, so a settings value
    // and its own identity string can never disagree by a float artifact.
    midtone: Math.round(midtone * 100) / 100,
    chokePx,
    garment,
    algorithmVersion: HALFTONE_ALGORITHM_VERSION,
  };
}

/**
 * THE TREATMENT IDENTITY STRING — what makes "these settings" a thing a job
 * can be keyed to (Goals 15, 16; test matrix Q and R).
 *
 * Every input that changes an output pixel appears here, so two plates with
 * the same key are the same plate and two plates with different keys are
 * genuinely different production intents. That is what makes a settings
 * change behave exactly like a size change already does: the queued job for
 * the old settings is superseded rather than silently re-aimed, and the new
 * settings get their own job with its own evidence.
 *
 * Deliberately a READABLE canonical string rather than a hash. It is stored
 * in a database column people read while diagnosing a physical print, and
 * `halftone_dtf/.../lpi=35/...` answers "what was this?" where a hex digest
 * only answers "was this the same?".
 */
export function productionTreatmentKey(
  selection: ProductionTreatmentSelection,
): string {
  if (selection.treatment === "standard_raster") return STANDARD_RASTER_TREATMENT_KEY;
  const s = selection.halftone;
  return [
    "halftone_dtf",
    s.algorithmVersion,
    `lpi=${s.lpi}`,
    `ang=${s.angleDeg}`,
    `dot=${s.dotShape}`,
    `tone=${s.midtone.toFixed(2)}`,
    `choke=${s.chokePx}`,
    `garment=${s.garment.hex}`,
  ].join("/");
}

/**
 * Whether a job's frozen treatment key still describes the project's current
 * treatment authority. The treatment half of the stale-intent fence — the
 * exact counterpart of `confirmedSizeMatchesJobWidth`.
 *
 * A legacy job (`null` key) abstains rather than failing, mirroring the
 * bound-width rule: it predates treatment binding, it can only ever have been
 * standard raster, and failing it would retroactively invalidate historical
 * plates that are still perfectly true.
 */
export function treatmentKeyMatchesJob(
  currentKey: string,
  jobTreatmentKey: string | null,
): boolean {
  if (jobTreatmentKey === null) return currentKey === STANDARD_RASTER_TREATMENT_KEY;
  return jobTreatmentKey === currentKey;
}

/**
 * The persisted treatment columns, exactly as they sit on
 * `TShirtDesignBrief`. Taken as a loose shape — like
 * `ProductionSizeConfirmationInput` — so the worker, the capability, the
 * routes, and the view layer can all call this without reconstructing a whole
 * brief.
 */
export interface ProductionTreatmentInput {
  productionTreatment: ProductionTreatment;
  halftoneSettings: HalftoneSettings | null;
  productionTreatmentSelectedAt: string | null;
}

/**
 * Resolves the project's durable treatment authority into the selection the
 * pipeline acts on.
 *
 * FAILS TO STANDARD RASTER in every incomplete case, and that direction is
 * chosen rather than convenient. The three columns are always written
 * together, so a treatment of `halftone_dtf` with no settings, or with
 * settings this build cannot read, or with no record of a human having
 * selected it, means the treatment decision is not intact — and the only safe
 * reading of a damaged decision is the representation nothing was relaxed for.
 * Guessing settings instead would produce a physical plate from values nobody
 * chose, which is the failure mode this whole phase is organized around.
 *
 * Never the reverse. Nothing here can turn a standard-raster project into a
 * halftone one, whatever else is missing or however standard raster fared.
 */
export function resolveProductionTreatment(
  input: ProductionTreatmentInput,
): ProductionTreatmentSelection {
  if (input.productionTreatment !== "halftone_dtf") {
    return { treatment: "standard_raster" };
  }
  if (!input.halftoneSettings || !input.productionTreatmentSelectedAt) {
    return { treatment: "standard_raster" };
  }
  return { treatment: "halftone_dtf", halftone: input.halftoneSettings };
}

/** Convenience: the project's current canonical treatment key. */
export function currentProductionTreatmentKey(
  input: ProductionTreatmentInput,
): string {
  return productionTreatmentKey(resolveProductionTreatment(input));
}

// ---------------------------------------------------------------------------
// Eligibility (Goal 3)
// ---------------------------------------------------------------------------

/**
 * Why halftone treatment is not being OFFERED for a project.
 *
 * Split into two kinds, and the split is load-bearing (see
 * `HalftoneEligibility.overridable`):
 *
 *   HARD — the treatment cannot produce anything meaningful. No operator
 *   override exists, because there is nothing to override into.
 *
 *   SOFT — the treatment would work but has nothing to offer THIS artwork.
 *   A solid-colour logo screened at 35 LPI is a solid-colour logo with holes
 *   in it. Not offered by default, but an operator who deliberately wants the
 *   garment-blend look on a flat logo is making a legitimate production
 *   choice and Goal 3 says so explicitly.
 */
export type HalftoneIneligibilityReason =
  /** HARD: not an apparel raster job, or an unsupported production profile. */
  | "unsupported_production_profile"
  /** HARD: no physical size has been confirmed, so there is no final geometry to screen at. */
  | "production_size_unconfirmed"
  /** HARD: no approved prepared transparent source exists to treat. */
  | "no_prepared_source"
  /** HARD: the prepared source has no visible pixels at all. */
  | "no_visible_artwork"
  /** HARD: the garment colour cannot be resolved, so the screen has no tonal reference point. */
  | "garment_color_unresolved"
  /** SOFT: effectively flat artwork — screening it removes ink and adds nothing. */
  | "no_tonal_content";

export type HalftoneEligibility =
  | { eligible: true; rationale: string }
  | {
      eligible: false;
      reason: HalftoneIneligibilityReason;
      /** True only for SOFT reasons — an operator may still deliberately select the treatment. */
      overridable: boolean;
      rationale: string;
    };

/**
 * The artwork-side measurement eligibility consumes, produced by
 * `measureHalftoneTonalContent` in `halftone-screen.ts`.
 *
 * Kept as a plain summary so this function stays pure and testable without a
 * decoded raster — the same reason `decideEnhancement` takes two numbers
 * rather than an image.
 */
export interface HalftoneSourceToneSummary {
  visiblePixelCount: number;
  /**
   * Fraction of visible pixels whose garment-relative tone lands strictly
   * inside the printable midrange — i.e. pixels a halftone screen would
   * render as a PARTIAL dot rather than as solid ink or bare garment. This is
   * the whole of what halftoning has to offer, expressed as a number.
   */
  midtoneFraction: number;
}

/**
 * Artwork below this much midtone content gains nothing measurable from a
 * screen. Deliberately low: the bar is "is there ANY tonal work to do", not
 * "is this a photograph".
 */
export const MIN_HALFTONE_MIDTONE_FRACTION = 0.05;

export interface HalftoneEligibilityInput {
  /** `ProductionRequirements.category` — only `apparel_raster` is treatable. */
  productionCategory: string;
  /** True when a human has confirmed the physical production size (Phase 1 authority). */
  productionSizeConfirmed: boolean;
  /** True when an approved, background-prepared transparent source exists. */
  preparedSourceAvailable: boolean;
  /** Resolved from `TShirtDesignBrief.shirtColor`; `null` when unresolvable. */
  garment: GarmentColor | null;
  /** `null` when the source has not been measured (treated as unknown, never as pass). */
  tone: HalftoneSourceToneSummary | null;
}

/**
 * WHETHER HALFTONE TREATMENT MAY BE OFFERED. Pure (Goal 3).
 *
 * Note what this is NOT, because the distinction is the point: eligibility is
 * not a success decision, not an authorization, and not a validation. It
 * answers only "would offering this to an operator make sense?". Whether the
 * operator is ALLOWED to choose it is the internal-entitlement gate; whether
 * the resulting plate is any good is `PrintValidationCapability`; whether it
 * physically prints is a press test nobody has run yet.
 *
 * It is also never consulted as a consequence of standard raster failing. A
 * project that would be eligible has been eligible all along.
 */
export function assessHalftoneEligibility(
  input: HalftoneEligibilityInput,
): HalftoneEligibility {
  if (input.productionCategory !== "apparel_raster") {
    return {
      eligible: false,
      reason: "unsupported_production_profile",
      overridable: false,
      rationale: `Halftone treatment is part of the apparel raster production profile; this job's category is ${input.productionCategory}.`,
    };
  }
  if (!input.productionSizeConfirmed) {
    return {
      eligible: false,
      reason: "production_size_unconfirmed",
      overridable: false,
      rationale:
        "The halftone screen is generated for a confirmed physical size; no size has been confirmed for this project.",
    };
  }
  if (!input.preparedSourceAvailable) {
    return {
      eligible: false,
      reason: "no_prepared_source",
      overridable: false,
      rationale:
        "Halftone treatment operates on the approved background-prepared transparent artwork, and this project has none.",
    };
  }
  if (!input.garment) {
    return {
      eligible: false,
      reason: "garment_color_unresolved",
      overridable: false,
      rationale:
        "The garment colour is the screen's tonal reference point and could not be resolved from the brief's stated product colour.",
    };
  }
  if (!input.tone || input.tone.visiblePixelCount <= 0) {
    return {
      eligible: false,
      reason: "no_visible_artwork",
      overridable: false,
      rationale:
        "The prepared artwork carries no visible pixels, so there is nothing for a screen to represent.",
    };
  }
  if (input.tone.midtoneFraction < MIN_HALFTONE_MIDTONE_FRACTION) {
    return {
      eligible: false,
      reason: "no_tonal_content",
      overridable: true,
      rationale:
        `Only ${(input.tone.midtoneFraction * 100).toFixed(1)}% of this artwork's visible pixels carry midtone against the garment — ` +
        "screening effectively flat artwork removes ink without representing anything the solid file did not already carry.",
    };
  }

  return {
    eligible: true,
    rationale: `${(input.tone.midtoneFraction * 100).toFixed(1)}% of visible pixels carry printable midtone against ${input.garment.label}; a screen has tonal work to do.`,
  };
}
