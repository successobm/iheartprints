"use client";

import { useEffect, useState } from "react";

/**
 * Intelligent Separation Phase 9: the INTERNAL OPERATOR's consequential-
 * region review surface (Goal 5).
 *
 * WHAT THIS COMPONENT DOES NOT DO. It never classifies a region itself, never
 * constructs a mask, and never decides which pixels change — every one of
 * those is server-side, deterministic, and re-verified on every write (see
 * `region-separation.ts` / `separation-review.ts`). This component is a thin
 * presentation layer over `SeparationReviewView`: it renders what the server
 * already decided and sends back only `{ regionId, intent }` pairs.
 *
 * SELF-CONTAINED BY DESIGN. Unlike `ProductionTreatmentPanel` (a prop-driven
 * slot inside the existing chat orchestration), this component fetches its
 * own state from the `separation` routes. That keeps the customer-facing
 * Existing Artwork flow (Goal 20) completely unaffected by this surface's
 * existence — nothing here is reachable unless something explicitly renders
 * it, and every route it calls independently re-enforces the internal-only
 * gate server-side (Goal 21/22) regardless of how this component got
 * mounted.
 */

type RegionIntent = "substrate" | "ink" | "uncertain";

interface ConsequentialRegion {
  regionId: number;
  pixelCount: number;
  pctOfArtworkBounds: number;
  bounds: { left: number; top: number; width: number; height: number };
}

interface RegionDecision {
  regionId: number;
  intent: RegionIntent;
  source: "operator" | "semantic_suggestion" | "deterministic";
  decidedAt: string;
}

interface SeparationReviewView {
  state:
    | "review_not_required"
    | "review_required"
    | "review_in_progress"
    | "review_complete"
    | "cannot_safely_automate";
  regionMap: {
    sourceAssetSha256: string;
    regionMapHash: string;
    consequentialRegions: ConsequentialRegion[];
  };
  decisions: RegionDecision[];
  pendingRegionIds: number[];
  postCheck: { orphanedLightInkPixels: number; passed: boolean; reasons: string[] } | null;
  approvedAt: string | null;
  isProductionAuthoritative: boolean;
}

export interface SeparationReviewPanelProps {
  projectId: string;
  /** The garment colour to preview against, as a hex string or a name `resolveGarmentColor` understands. Preview only — never pixel authority (Goal 6). */
  garmentColor: string;
  /**
   * Intelligent Separation Phase 10: fires whenever this panel's
   * authoritative state changes, including the initial load (`null` while
   * loading or when no review exists at all). This is the ONE piece of
   * separation state the surrounding Existing Artwork flow needs — whether
   * its own one-click "Use Prepared Artwork" control remains safe to offer —
   * and it is lifted rather than re-fetched, so this panel stays the single
   * place that reads or writes separation state (Goal 3).
   */
  onStateChange?: (state: SeparationReviewView["state"] | null) => void;
  /**
   * Fires after "Use This Preparation" succeeds. `approveSeparationMaster`
   * updates `preparedAssetId` and the project's status server-side, which
   * this self-contained panel has no reason to know how to re-fetch — the
   * parent already owns that refresh (the same one every other preparation
   * action triggers).
   */
  onApproved?: () => void;
}

const GARMENT_INSPECTION_SURFACES = [
  { key: "black", hex: "#000000", label: "Black" },
  { key: "white", hex: "#FFFFFF", label: "White" },
  { key: "red", hex: "#B22234", label: "Red" },
  { key: "gray", hex: "#C8C8C8", label: "Gray" },
] as const;

const INTENT_COPY: Record<RegionIntent, { label: string; helper: string }> = {
  substrate: {
    label: "Show Shirt",
    helper: "This area becomes transparent and the garment colour shows through.",
  },
  ink: {
    label: "Print Ink",
    helper: "Keep the original artwork pixels here.",
  },
  uncertain: {
    label: "Not Sure",
    helper: "Preserve the artwork here and require review before this can be used.",
  },
};

export function SeparationReviewPanel({
  projectId,
  garmentColor,
  onStateChange,
  onApproved,
}: SeparationReviewPanelProps) {
  const [view, setView] = useState<SeparationReviewView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewSurface, setPreviewSurface] = useState<string>(garmentColor);
  const [finalReviewOpen, setFinalReviewOpen] = useState(false);
  const [imageNonce, setImageNonce] = useState(0);

  // Called exactly once, from the mount effect below — `loading`/`error`
  // already start at their correct values (`true`/`null`), so this never
  // needs to set them synchronously itself.
  async function load() {
    try {
      const res = await fetch(`/api/projects/${projectId}/artwork-preparation/separation`);
      if (res.status === 404) {
        setView(null);
        return;
      }
      if (!res.ok) throw new Error("Failed to load the separation review");
      const data = (await res.json()) as SeparationReviewView;
      setView(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the separation review");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    // Deferred so the effect body stays free of synchronous setState
    // (react-hooks/set-state-in-effect) — same pattern
    // `FinalArtworkDeliveryCard` already uses for the identical fetch-on-
    // mount shape.
    const timer = setTimeout(() => {
      if (!cancelled) void load();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Mirrors this panel's state up to the parent — a plain callback, not a
  // second fetch, so `SeparationReviewPanel` stays the only reader/writer of
  // separation state (Goal 3). Calling a PARENT's setter from here is not
  // the self-referential pattern `react-hooks/set-state-in-effect` guards
  // against; that rule targets a component setting its OWN state
  // synchronously in an effect, which this does not do.
  useEffect(() => {
    onStateChange?.(view?.state ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.state]);

  async function decide(regionId: number, intent: RegionIntent) {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/artwork-preparation/separation/decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAssetSha256: view.regionMap.sourceAssetSha256,
          regionMapHash: view.regionMap.regionMapHash,
          decisions: [{ regionId, intent }],
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "That decision could not be saved");
      }
      const data = (await res.json()) as SeparationReviewView;
      setView(data);
      setImageNonce((n) => n + 1);
      // A decision NEVER auto-finalizes anything (Goal 17) — the operator
      // still has to reach the final review step explicitly.
    } catch (e) {
      setError(e instanceof Error ? e.message : "That decision could not be saved");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/artwork-preparation/separation/approve`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "This preparation could not be approved");
      }
      const data = (await res.json()) as SeparationReviewView;
      setView(data);
      setFinalReviewOpen(false);
      onApproved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "This preparation could not be approved");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted">Checking whether this artwork needs a separation review…</p>;
  }
  if (!view || view.state === "review_not_required") {
    // Goal 20: no consequential regions — this artwork needs nothing from
    // this surface, and the existing Existing Artwork workflow is untouched.
    return null;
  }

  const complete = view.state === "review_complete";
  const staleOrBroken = view.state === "cannot_safely_automate";

  return (
    <div className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm" data-separation-review-state={view.state}>
      <p className="text-sm font-semibold text-ink">Review the artwork&rsquo;s dark areas</p>
      <p className="mt-1 text-sm text-muted">
        A few areas of this artwork are the same colour as its background. For each one, decide whether the
        garment should show through or the artwork should print as ink.
      </p>

      {error ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900" role="alert">
          {error}
        </p>
      ) : null}

      {staleOrBroken ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900" role="alert">
          This review is out of date — reload before continuing.
        </p>
      ) : null}

      <div className="mt-3 space-y-3" data-region-list>
        {view.regionMap.consequentialRegions.map((region) => {
          const decision = view.decisions.find((d) => d.regionId === region.regionId);
          const current = decision?.intent ?? null;
          return (
            <div
              key={region.regionId}
              className="rounded-xl border border-black/8 p-3"
              data-region-id={region.regionId}
              data-region-decided={current !== null && current !== "uncertain"}
            >
              <div className="flex flex-wrap items-start gap-3">
                {/* Phase 14: two views, not one. The context thumbnail answers
                    "where in the whole artwork is this?"; the detail crop
                    (zoomed to the region's own bounds, never the full
                    canvas) answers "what exactly am I deciding about?" — the
                    question the old single full-canvas thumbnail left
                    unanswerable once 18 regions all looked alike at that
                    scale. Both derive from the SAME server-computed region
                    id; neither is a second segmentation implementation. */}
                <div className="flex shrink-0 flex-col items-center gap-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/projects/${projectId}/artwork-preparation/separation/image?mode=region-context&region=${region.regionId}&v=${imageNonce}`}
                    alt={`Full artwork with region ${region.regionId} outlined and everything else dimmed`}
                    className="h-20 w-20 rounded-lg border border-black/8 object-contain"
                    data-region-context
                  />
                  <span className="text-[10px] text-muted">Full artwork</span>
                </div>
                <div className="flex shrink-0 flex-col items-center gap-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/projects/${projectId}/artwork-preparation/separation/image?mode=region-crop&region=${region.regionId}&v=${imageNonce}`}
                    alt={`Close-up of region ${region.regionId}, outlined against the surrounding artwork`}
                    className="h-40 w-40 rounded-lg border-2 border-ink/15 object-contain"
                    data-region-detail
                  />
                  <span className="text-[10px] text-muted">Close-up</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">Should the shirt show through here?</p>
                  <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={`Decision for region ${region.regionId}`}>
                    {(["substrate", "ink", "uncertain"] as const).map((intent) => (
                      <button
                        key={intent}
                        type="button"
                        disabled={busy}
                        onClick={() => decide(region.regionId, intent)}
                        aria-pressed={current === intent}
                        data-intent-button={intent}
                        className={
                          current === intent
                            ? "rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-white"
                            : "rounded-full border border-black/10 px-3 py-1.5 text-xs font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
                        }
                      >
                        {INTENT_COPY[intent].label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted">
                    {current ? INTENT_COPY[current].helper : "No decision yet — this area is currently preserved."}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {!finalReviewOpen ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy || !complete}
            onClick={() => setFinalReviewOpen(true)}
            className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Review before continuing
          </button>
          {!complete ? (
            <span className="text-xs text-muted" data-pending-count>
              {view.pendingRegionIds.length} area{view.pendingRegionIds.length === 1 ? "" : "s"} still need a decision
            </span>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-black/8 bg-black/[0.02] p-3" data-final-review>
          <p className="text-sm font-semibold text-ink">Review your artwork before continuing.</p>

          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Preview garment colour">
            {GARMENT_INSPECTION_SURFACES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setPreviewSurface(s.hex)}
                aria-pressed={previewSurface === s.hex}
                className={
                  previewSurface === s.hex
                    ? "rounded-full border border-ink bg-ink px-3 py-1 text-xs font-medium text-white"
                    : "rounded-full border border-black/10 px-3 py-1 text-xs font-medium text-ink"
                }
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink">Original</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/projects/${projectId}/artwork-preparation/separation/image?mode=original`}
                alt="Original artwork, untouched"
                className="mt-1 max-h-64 w-full rounded-lg border border-black/8 object-contain"
              />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink">Prepared</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/projects/${projectId}/artwork-preparation/separation/image?mode=master-preview&garment=${encodeURIComponent(previewSurface)}&v=${imageNonce}`}
                alt="Resulting prepared artwork on the selected garment colour"
                className="mt-1 max-h-64 w-full rounded-lg border border-black/8 object-contain"
                style={{ backgroundColor: previewSurface }}
              />
            </div>
          </div>

          {view.postCheck && view.postCheck.orphanedLightInkPixels > 0 ? (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              Some light-coloured artwork near a &ldquo;Show Shirt&rdquo; area may lose contrast on light garments. Check the
              White and Gray previews above before continuing.
            </p>
          ) : null}

          <p className="mt-2 text-xs text-muted">Your original upload is saved and unchanged.</p>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={approve}
              className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Use This Preparation
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setFinalReviewOpen(false)}
              className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              Back to decisions
            </button>
          </div>
        </div>
      )}

      {view.isProductionAuthoritative ? (
        <p className="mt-3 text-xs text-ink" data-production-authoritative>
          This preparation is approved and in use.
        </p>
      ) : null}
    </div>
  );
}
