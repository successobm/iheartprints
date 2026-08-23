"use client";

import type { CSSProperties } from "react";

/**
 * Existing Artwork → Print Ready Phase 1.5: presentation-only QA backgrounds.
 *
 * The prepared PNG stays garment-neutral. White / Gray / Black exist so
 * customers can inspect transparency and edges before confirming cleanup or
 * approving prepared artwork. Switching a preview background must never alter
 * alpha, RGB, cleanup state, preparedRevision, or production bytes.
 */

export const PREVIEW_BACKGROUNDS = ["white", "gray", "black"] as const;

export type PreviewBackground = (typeof PREVIEW_BACKGROUNDS)[number];

/**
 * Neutral by default, because the default must not favour either half of the
 * artwork.
 *
 * This was `"white"`, chosen as the strongest surface for spotting dark
 * residue. It is — but it is also the worst possible surface for artwork that
 * is largely WHITE. The audited bowling logo is built for a dark garment: its
 * outer ring, tagline, pin bodies and letter faces are all white, and against
 * a white inspection surface every one of them disappears while sitting at
 * full alpha. The prepared file was intact and the preview made it look
 * destroyed, at exactly the moment the customer has to decide whether to
 * approve it.
 *
 * Mid-gray is the only one of the three that is honest about light AND dark
 * content at once. White and Black stay one click away as targeted checks —
 * White for dark residue, Black for light residue — which is what they are
 * actually good at.
 */
export const DEFAULT_PREVIEW_BACKGROUND: PreviewBackground = "gray";

export const PREVIEW_BACKGROUND_COLORS: Record<PreviewBackground, string> = {
  white: "#FFFFFF",
  /** Neutral mid/light gray — useful contrast without matching black art. */
  gray: "#C8C8C8",
  black: "#000000",
};

export const PREVIEW_BACKGROUND_COPY = {
  label: "Preview Background",
  helper: "Check your artwork on different backgrounds before approving it.",
  /**
   * Intelligent Separation Phase 3: shown ONLY when the server's preparation
   * review evidence recommends a closer look (`reviewRequired`). Never
   * implies a specific surface will reveal a specific problem — it just asks
   * for the same three-surface check `helper` already offers, more firmly.
   */
  reviewEmphasis: "Check Gray, White, and Black if you're unsure.",
  approvalGuidance:
    "Make sure all parts of your design are still there and the background looks clean.",
  approvalTip:
    "Gray shows light and dark artwork at once. Try White to spot dark background residue, Black to spot light residue.",
  options: {
    white: "White",
    gray: "Gray",
    black: "Black",
  },
} as const;

export function isPreviewBackground(value: string): value is PreviewBackground {
  return (PREVIEW_BACKGROUNDS as readonly string[]).includes(value);
}

/**
 * Solid inspection surface only — no gradients, no checkerboard rewrite of
 * artwork pixels. The transparent PNG sits above this CSS layer unchanged.
 */
export function previewBackgroundSurfaceStyle(
  background: PreviewBackground,
): CSSProperties {
  return {
    backgroundColor: PREVIEW_BACKGROUND_COLORS[background],
  };
}

/**
 * Candidate highlight presentation that stays readable on White, Gray, and
 * Black. Geometry still comes from the server; this is outline/hatch chrome.
 */
export function candidateHighlightFrameClassName(): string {
  return [
    "pointer-events-none absolute border-2 border-dashed",
    // Amber reads on dark; near-black ring reads on white/gray.
    "border-amber-400",
    "shadow-[0_0_0_1px_rgba(0,0,0,0.85),inset_0_0_0_1px_rgba(255,255,255,0.85)]",
    // Hatch via repeating gradient — not color alone.
    "[background-image:repeating-linear-gradient(-45deg,rgba(251,191,36,0.35)_0_6px,transparent_6px_12px)]",
  ].join(" ");
}
