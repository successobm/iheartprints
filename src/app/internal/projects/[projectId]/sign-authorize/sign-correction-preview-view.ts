/**
 * Signs Workstation Visual Correction UX Phase: the pure decision logic
 * behind "what does the main canvas show, and is Apply actually safe to
 * press right now" — extracted from `SignFitToProductionCorrectionTool.tsx`
 * the same way `sign-canvas-zoom.ts`/`sign-workspace-status.ts` already
 * extract that component's other pure derivations, so this logic (the
 * 20-item acceptance matrix's decision rules) can be tested directly and
 * deterministically, without a browser or a simulated DOM.
 *
 * GOVERNING RULE (Section B of the driving task): no correction may be
 * applied unless the operator can clearly see its effect at useful scale
 * first. Every function here exists to make that true regardless of what
 * transient/stale state the component might otherwise be holding:
 * `resolveEffectiveViewMode` can never claim "preview" when there is
 * nothing real to show, and `canApplyCorrectionQueue` can never permit
 * Apply against a queue the operator hasn't actually seen the true,
 * fully-applied result of.
 */

/** The subset of `previewSignCorrections`'s response this module's decisions depend on. */
export interface CorrectionPreviewViewState {
  status: "no_candidate" | "refused" | "previewed";
  appliedCount: number;
  hasPixelChange: boolean;
  afterPngBase64: string | null;
}

/**
 * A real, pixel-changing preview exists to show only when the correction
 * queue actually changed pixels (never true for a classification-only
 * queue — Edge Artwork/Border and Protected are governance metadata, not
 * pixel edits) AND the server actually returned the full-canvas bytes for
 * it. `null` (no preview computed yet — nothing queued) is never showable.
 */
export function canShowPixelPreview(preview: CorrectionPreviewViewState | null): boolean {
  return preview !== null && preview.hasPixelChange && preview.afterPngBase64 !== null;
}

/**
 * What the main canvas ACTUALLY uses, regardless of what the operator's
 * own toggle selection (`requestedViewMode`) remembers — forces
 * `"original"` whenever there is nothing real to preview, so a stale
 * "preview" choice from a prior (now-cleared, or classification-only)
 * queue can never make the canvas silently show something that isn't
 * there.
 */
export function resolveEffectiveViewMode(
  requestedViewMode: "original" | "preview",
  preview: CorrectionPreviewViewState | null,
): "original" | "preview" {
  return canShowPixelPreview(preview) ? requestedViewMode : "original";
}

/** The main canvas `<img>` source for the given effective view mode. */
export function resolveMainImageSrc(
  effectiveViewMode: "original" | "preview",
  preview: CorrectionPreviewViewState | null,
  candidateUrl: string,
): string {
  if (effectiveViewMode === "preview" && preview?.afterPngBase64) {
    return `data:image/png;base64,${preview.afterPngBase64}`;
  }
  return candidateUrl;
}

/**
 * True when the CURRENT queue is non-empty but consists entirely of
 * pixel-free classification corrections — the UI must say so explicitly
 * rather than show a meaningless (pixel-identical) Before/After.
 */
export function isClassificationOnlyQueue(preview: CorrectionPreviewViewState | null, queueLength: number): boolean {
  return preview !== null && !preview.hasPixelChange && queueLength > 0;
}

/**
 * Apply is safe only when ALL of: nothing is currently in flight; there is
 * a queue to apply; the current preview fully succeeded (never `"refused"`
 * or `"no_candidate"`); and the preview's own `appliedCount` accounts for
 * every entry in the current queue — the deterministic tie between "what
 * the operator was just shown" and "what Apply would actually submit"
 * (Section L), using the SAME `appliedCount` the preview response already
 * carries rather than inventing a second identity/hash mechanism.
 */
export function canApplyCorrectionQueue(input: {
  busy: boolean;
  queueLength: number;
  preview: CorrectionPreviewViewState | null;
}): boolean {
  return (
    !input.busy &&
    input.queueLength > 0 &&
    input.preview !== null &&
    input.preview.status === "previewed" &&
    input.preview.appliedCount === input.queueLength
  );
}
