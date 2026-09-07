"use client";

import type { CSSProperties } from "react";

import { resolveGarmentColor } from "@/capabilities/shared/production-treatment";

/**
 * Existing Artwork → Print Ready Phase 1.5: presentation-only QA backgrounds.
 *
 * The prepared PNG stays garment-neutral. White / Gray / Black exist so
 * customers can inspect transparency and edges before confirming cleanup or
 * approving prepared artwork. Switching a preview background must never alter
 * alpha, RGB, cleanup state, preparedRevision, or production bytes.
 *
 * DTF Custom Preview Background Phase: White / Gray / Black are deliberate
 * inspection surfaces (light residue, dark residue, halos, transparency) and
 * stay exactly as they were. `PreviewSurface` adds ONE more option, `"custom"`
 * — an arbitrary customer-chosen colour, for the separate, equally real
 * question those three can't answer: "what will this look like on the
 * garment I'm actually printing on?" Same invariant as always: this is a CSS
 * layer under the transparent PNG, never a pixel rewrite.
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
  helper:
    "Check your artwork on different backgrounds before approving it. Preview colors are never added to your artwork.",
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
    custom: "Custom Color",
  },
  /** Accessible name for the native `<input type="color">` — never assumes the customer knows what a hex code is. */
  customColorInputLabel: "Choose a custom preview color",
} as const;

export function isPreviewBackground(value: string): value is PreviewBackground {
  return (PREVIEW_BACKGROUNDS as readonly string[]).includes(value);
}

/** The fourth, arbitrary-colour option alongside White / Gray / Black. */
export const CUSTOM_PREVIEW_SURFACE = "custom" as const;

/** Every selectable preview surface: the three fixed presets, plus custom. */
export type PreviewSurface = PreviewBackground | typeof CUSTOM_PREVIEW_SURFACE;

export function isPreviewSurface(value: string): value is PreviewSurface {
  return isPreviewBackground(value) || value === CUSTOM_PREVIEW_SURFACE;
}

/**
 * Shown the first time a customer opens the custom colour picker, before
 * they have chosen anything themselves (or when no garment colour could be
 * resolved to seed it — see `resolveGarmentPreviewColor`). An arbitrary but
 * clearly-a-colour starting point, never black or white, so it reads as
 * "pick your own" rather than coinciding with an existing preset.
 */
export const DEFAULT_CUSTOM_PREVIEW_COLOR = "#1F3FAF";

/** `#RRGGBB` only — what every browser `<input type="color">` produces. */
export function isValidHexColor(value: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(value.trim());
}

/** `null` for anything that isn't a genuine `#RRGGBB` colour — never guessed. */
export function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  return isValidHexColor(trimmed) ? `#${trimmed.slice(1).toUpperCase()}` : null;
}

/** Case-insensitive `#RRGGBB` comparison — a native colour input always
 * lowercases, while a resolved garment hex is uppercase. */
export function sameHexColor(a: string, b: string): boolean {
  return (normalizeHexColor(a) ?? a).toUpperCase() === (normalizeHexColor(b) ?? b).toUpperCase();
}

/**
 * The actual CSS colour for any selectable surface, custom included. An
 * invalid/empty custom value (should not happen from a native colour input,
 * but this is the one place a bad value could otherwise reach `<style>`)
 * falls back to {@link DEFAULT_CUSTOM_PREVIEW_COLOR} rather than producing
 * `undefined` CSS.
 */
export function resolvePreviewSurfaceHex(
  surface: PreviewSurface,
  customColorHex: string,
): string {
  if (surface === CUSTOM_PREVIEW_SURFACE) {
    return normalizeHexColor(customColorHex) ?? DEFAULT_CUSTOM_PREVIEW_COLOR;
  }
  return PREVIEW_BACKGROUND_COLORS[surface];
}

/**
 * Solid inspection surface for any of the four surfaces — same discipline as
 * {@link previewBackgroundSurfaceStyle}: only ever `backgroundColor`, no
 * gradients, no compositing, no artwork pixel involved.
 */
export function previewSurfaceStyle(
  surface: PreviewSurface,
  customColorHex: string,
): CSSProperties {
  return { backgroundColor: resolvePreviewSurfaceHex(surface, customColorHex) };
}

export interface ResolvedGarmentPreviewColor {
  /** The customer's own stated garment colour text, e.g. "Blue" — never relabeled. */
  readonly label: string;
  readonly hex: string;
}

/**
 * Optional convenience: resolves the garment colour the customer already
 * entered elsewhere in the DTF flow (`ArtworkPreparation.productColor`) to a
 * real preview hex, reusing the SAME table-driven `resolveGarmentColor` the
 * garment-preview compositing route already trusts — never a second parsing
 * implementation. `null` when unset or unresolvable; callers must not guess
 * or silently fall back to a default colour for this optional preset (unlike
 * `resolveInitialPreviewSurfaceHex` in `garment-preview-surface.ts`, whose
 * white fallback is a policy specific to that other, server-compositing
 * screen — this one simply has nothing to offer).
 */
export function resolveGarmentPreviewColor(
  garmentColor: string | null | undefined,
): ResolvedGarmentPreviewColor | null {
  const resolved = resolveGarmentColor(garmentColor ?? undefined);
  if (!resolved) return null;
  return { label: resolved.label, hex: resolved.hex };
}

export function garmentPresetChipLabel(label: string): string {
  return `Garment: ${label}`;
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
