import type { GenerationPromptRequest } from "./types";

export interface ConceptSeed {
  versionNumber: number;
  title: string;
  summary: string;
  placeholderLabel: string;
  accentColor: string;
}

/**
 * Sprint 2H Part 1: now takes the provider-neutral `GenerationPromptRequest`
 * (the same input every real provider adapter receives) instead of the raw
 * Design Brief, so the placeholder path stays a faithful stand-in for a
 * real provider rather than a special case.
 */
export function buildPlaceholderConcepts(
  prompt: GenerationPromptRequest,
): ConceptSeed[] {
  const subject = prompt.subject.trim() || "your design";
  const shirt = prompt.productColor?.trim() || "the shirt";
  const text = prompt.requiredWording
    ? `Featuring the text "${prompt.requiredWording}".`
    : "No text lockup — graphic-led.";

  return [
    {
      versionNumber: 1,
      title: "Bold & Direct",
      placeholderLabel: "Concept A",
      accentColor: "#1f6f5b",
      summary: `High-contrast take on ${subject} for a ${shirt} shirt. ${text} Clean shapes, strong silhouette, easy to print.`,
    },
    {
      versionNumber: 2,
      title: "Soft & Illustrated",
      placeholderLabel: "Concept B",
      accentColor: "#3d5a80",
      summary: `Warmer, illustrated direction for ${subject}. ${text} Softer edges and a friendlier poster feel on ${shirt}.`,
    },
    {
      versionNumber: 3,
      title: "Minimal Badge",
      placeholderLabel: "Concept C",
      accentColor: "#7a4e2d",
      summary: `Compact badge-style layout centered on ${subject}. ${text} Designed to sit cleanly on ${shirt} without clutter.`,
    },
  ];
}
