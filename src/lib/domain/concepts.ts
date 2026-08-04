import type { TShirtDesignBrief } from "./types";

export interface ConceptSeed {
  versionNumber: number;
  title: string;
  summary: string;
  placeholderLabel: string;
  accentColor: string;
}

export function buildPlaceholderConcepts(
  brief: TShirtDesignBrief,
): ConceptSeed[] {
  const subject = brief.designDescription?.trim() || "your design";
  const shirt = brief.shirtColor?.trim() || "the shirt";
  const text =
    brief.exactText && brief.exactText.length > 0
      ? `Featuring the text "${brief.exactText}".`
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
