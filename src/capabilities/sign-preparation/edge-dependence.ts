/**
 * Signs — Perimeter Safety Phase: the deterministic EDGE-DEPENDENCE signal.
 *
 * Real DTF/Signs customer incident (project cc6cfc4b-...): a warning/
 * inspection sign whose artwork carried a designed perimeter border, a
 * rounded-corner treatment, and corner mounting-hole indicators — all
 * meaningful only relative to the FINISHED PHYSICAL SIGN edge. The source's
 * aspect ratio (3:4) did not match the ordered substrate (2:3), so
 * `sign-repair-planner.ts` extended the canvas with `pad_uniform_background`
 * — every pixel preserved, nothing cropped or stretched, dimensions/PPI
 * correct — and a human production operator still rejected the result: the
 * padding pushed the border and mounting-hole indicators inward, away from
 * the edges/corners the finished sign will actually have. The artwork's
 * pixels were preserved; its PRODUCTION MEANING was not.
 *
 * `SignEdgeClassification` (`edge-inspection.ts`) answers a narrower
 * question: "is this edge band affirmatively one flat background colour, so
 * an extension can literally never visibly disagree with it?" That is a
 * SEAM-QUALITY question. This module answers a different one: "does
 * something in this edge band look like it structurally belongs to the
 * finished perimeter, regardless of whether the classifier's three-way
 * bucket happened to land on `foreground_bleed` or `mixed_or_uncertain`?"
 * The real incident's edge evidence classified `mixed_or_uncertain` on
 * every edge — its `dominantCoverage` (~0.595) narrowly missed
 * `foreground_bleed`'s own 0.6 floor by chance, which is exactly why
 * retuning that one constant would be threshold-fitting, not a fix: it
 * would still conflate "ambiguous background" with "meaningful structure
 * tied to the finished edge," just with the boundary moved slightly.
 *
 * THE SIGNAL. Uses only evidence `edge-inspection.ts` already computes —
 * zero new pixel analysis, zero new provider call:
 *
 *   dominantCoverage          — fraction of the WHOLE band matching its own
 *                               dominant colour.
 *   outermostCoverage        — fraction of the SINGLE outermost pixel line
 *                               matching that same dominant colour.
 *   longestNonBackgroundRunPx — the longest CONTIGUOUS non-background run
 *                               on that same outermost line.
 *
 * A band is flagged edge-dependent only when ALL THREE hold together: a
 * REAL, substantial background colour exists at all (`dominantCoverage`
 * clears a floor — see below), the outermost line is mostly NOT that
 * colour (low `outermostCoverage`), AND whatever occupies it forms one long
 * continuous run rather than scattered noise (high
 * `longestNonBackgroundRunPx` relative to the edge's own length). Each
 * condition alone is not enough, and the `dominantCoverage` floor is not
 * optional decoration — it was added after the first two-condition version
 * of this signal false-positived on `noisyEdgeSignArtwork` (pure per-pixel
 * noise, no structure at all):
 *
 *   - Low `outermostCoverage` and a long run can BOTH happen on purely
 *     random noise for a reason that is easy to miss: with no repeating
 *     colour at all, a "dominant" bucket still technically exists (SOME
 *     bucket has the most pixels, even at ~0.2% share of the band) but
 *     essentially never recurs, so almost every pixel on the outermost line
 *     "extends" the non-background run by sheer absence of any real
 *     background to interrupt it — nearly the entire line reads as one
 *     giant contiguous run purely because nothing is actually background.
 *     Requiring `dominantCoverage` to clear a real, substantial floor (not
 *     merely "whichever bucket happened to win") is what tells a genuine
 *     background-plus-content band apart from no coherent background at
 *     all.
 *   - A long run alone (with a real background) can happen from a SMALL,
 *     clearly local decoration — but `outermostCoverage` measures the
 *     OUTERMOST line's own share, so a run buried deeper in the band
 *     (never reaching that outermost line at all) never drives
 *     `outermostCoverage` down in the first place.
 *
 * CALIBRATION (never fit to the one real image — see
 * `sign-repair-planner.test.ts` and `sign-fixtures.ts` for the full fixture
 * set this was checked against before picking these numbers):
 *
 *   - A genuinely empty/uniform extension-safe margin
 *     (`uniformBackgroundSignArtwork`): `dominantCoverage` ~1.0,
 *     `outermostCoverage` ~1.0, `longestNonBackgroundRunPx` ~0 — nowhere
 *     near any bound.
 *   - Pure per-pixel noise with no structure at all
 *     (`noisyEdgeSignArtwork`): `dominantCoverage` ~0.002–0.003 — the
 *     "dominant" bucket is essentially arbitrary, nowhere near the floor
 *     below, regardless of how extreme `outermostCoverage`/
 *     `longestNonBackgroundRunPx` happen to look.
 *   - Ordinary foreground that happens to approach/touch an edge without
 *     forming a perimeter system (`ruthLikeSignArtwork`'s rainbow bleeding
 *     off the side edges): `dominantCoverage` ~0.875 (a real background),
 *     `outermostCoverage` ~0.875 (HIGH — the bleed is a small band within
 *     the edge's own length, so most of the outermost line is still
 *     background), and a run covering only ~12.5% of the edge length —
 *     clears the dominant-coverage floor but neither of the other two
 *     bounds. Deliberately proven at the SAME `foreground_bleed`
 *     classification as the flagged cases below
 *     (`sign-repair-planner.test.ts`'s continuous-perimeter fixture), so
 *     the signal is proven to distinguish WITHIN one classification bucket,
 *     not merely across buckets.
 *   - A continuous perimeter/frame structure and the real incident's own
 *     measured evidence: `dominantCoverage` ~0.58–0.87 (a real background
 *     still exists), `outermostCoverage` ~0.06–0.07,
 *     `longestNonBackgroundRunPx` ~93–94% of the edge length — all three
 *     bounds cleared with a wide margin.
 *
 * `EDGE_DEPENDENCE_MIN_DOMINANT_COVERAGE` sits at 0.3 — roughly 2x below
 * the real/flagged cases' own ~0.58 floor, and roughly 100x above pure
 * noise's ~0.003. `EDGE_DEPENDENCE_MAX_OUTERMOST_COVERAGE`/
 * `EDGE_DEPENDENCE_MIN_RUN_FRACTION` sit at the round midpoint (0.5) —
 * roughly 7x away from the real/flagged cases on one side and roughly
 * 1.75x–7x away from the safe cases on the other. Conservative on purpose:
 * a false negative here can create a genuine Print Ready false positive
 * (the exact incident this module exists to prevent), which is a
 * materially worse outcome than a false positive routing an ordinary job
 * to review/block that did not need it.
 */

import type { SignEdge, SignEdgeEvidence } from "./contracts";

/** Below this, no REAL background colour exists in the band at all — see the module doc comment for why this guards against pure noise. */
export const EDGE_DEPENDENCE_MIN_DOMINANT_COVERAGE = 0.3;

/** Below this, the SINGLE outermost pixel line is no longer provably the band's own background — see the module doc comment for calibration. */
export const EDGE_DEPENDENCE_MAX_OUTERMOST_COVERAGE = 0.5;

/** At or above this fraction of the edge's own length, a single contiguous non-background run is structural, not incidental noise. */
export const EDGE_DEPENDENCE_MIN_RUN_FRACTION = 0.5;

/**
 * Whether ONE edge's already-computed evidence shows a continuous,
 * near-edge structure consistent with artwork whose meaning depends on the
 * finished substrate boundary. Pure; re-derivable at any time from an
 * already-persisted `SignEdgeEvidence` — never itself persisted.
 */
export function isEdgeDependentStructure(evidence: SignEdgeEvidence): boolean {
  if (evidence.edgeLengthPx <= 0) return false;
  const runFraction = evidence.longestNonBackgroundRunPx / evidence.edgeLengthPx;
  return (
    evidence.dominantCoverage >= EDGE_DEPENDENCE_MIN_DOMINANT_COVERAGE &&
    evidence.outermostCoverage <= EDGE_DEPENDENCE_MAX_OUTERMOST_COVERAGE &&
    runFraction >= EDGE_DEPENDENCE_MIN_RUN_FRACTION
  );
}

/**
 * The pair of edges a geometry-extension `axis` affects — mirrors
 * `sign-repair-planner.ts`'s own inline mapping and
 * `sign-preparation-operator-copy.ts`'s private `edgesForAxis`, kept here as
 * the one shared, importable copy for callers (`final-artwork-worker-
 * capability.ts`'s PrintValidation evidence assembly) that only have the
 * PLAN's own persisted `axis` string, never the planner's live local
 * variables.
 */
export function affectedEdgesForAxis(
  axis: string | null | undefined,
): [SignEdge, SignEdge] | null {
  if (axis === "horizontal") return ["left", "right"];
  if (axis === "vertical") return ["top", "bottom"];
  return null;
}

/** True when ANY of `edges` (by `SignEdge` name) has edge-dependent evidence in `allEdges`. Missing evidence for a named edge is never treated as dependent (fails toward "nothing to flag", not toward a fabricated positive) — the caller's own evidence set is always structurally complete in practice (`inspectAllSignEdges` always returns all four). */
export function anyEdgeIsEdgeDependent(
  allEdges: readonly SignEdgeEvidence[],
  edges: readonly SignEdge[],
): boolean {
  return edges.some((edge) => {
    const evidence = allEdges.find((candidate) => candidate.edge === edge);
    return evidence !== undefined && isEdgeDependentStructure(evidence);
  });
}
