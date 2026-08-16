/**
 * Sprint A2 (corrected) — the DETERMINISTIC SAFETY NET for "what production
 * artifact is iHeartPrints being asked to produce?".
 *
 * Authority model, stated first because it decides everything below:
 *
 *   1. Conversation Understanding (semantic) is the PRIMARY interpreter.
 *   2. This module is the deterministic backstop for when that layer is
 *      offline, unconfigured, or returns nothing — so an unmistakable
 *      request is never silently lost.
 *   3. The resolved value is PERSISTED on the working brief and is the
 *      authority from then on. Finalization reads the stored value; it never
 *      re-runs this module over prose.
 *
 * That ordering is why this module is tuned for PRECISION, not recall. The
 * two failure modes are not symmetric:
 *
 *   - A false NEGATIVE here degrades to the semantic layer, and failing
 *     that, to today's behavior: the customer gets a Production PNG. That is
 *     the status quo, and the conversation can still correct it.
 *   - A false POSITIVE silently refuses a paying customer's valid artwork
 *     because a word appeared in their sentence.
 *
 * So when in any doubt, this module returns `null` and says nothing.
 *
 * Every disqualifier below is a real case from the Codex audit of the first
 * A2 pass, which had none of them and would have blocked all of these:
 *
 *     "no separations are needed"                    → negation
 *     "don't digitize this"                          → negation
 *     "DON'T DIGITIZE ME" (as shirt wording)         → negation + quoted
 *     "I already have the DST file"                  → possession
 *     "this came from an embroidery file"            → possession/origin
 *     "use this SVG only as a reference"             → reference
 *     "I uploaded an SVG logo"                       → supplied-by-customer
 *     shirt wording "COLOR SEPARATIONS"              → quoted
 *     "Screen Print Separations LLC"                 → business name
 *     "embroidery digitizing is our business"        → predicate, not request
 */

import { clauseBoundarySource } from "@/lib/domain/clause-boundaries";
import type { RequestedProductionOutput } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Artifact vocabulary
// ---------------------------------------------------------------------------

/**
 * The ARTIFACT being asked for. Keyed on nouns (and the one verb that names
 * only this act, "digitize") because imperative verbs — create, make, give
 * me — saturate ordinary design requests, while "DST file" and "colour
 * separations" name nothing else.
 */
const ARTIFACT_PATTERNS: Array<[RegExp, RequestedProductionOutput]> = [
  [
    /\b(?:dst|pes|exp|jef|vp3|hus|pec)\b|\bembroidery\s+(?:file|format)\b|\bmachine\s+embroidery\b|\bstitch\s+(?:file|out)\b|\bdigitiz(?:e|ed|ing|ation)\b|\bpunch(?:ed|ing)?\s+for\s+embroidery\b/i,
    "embroidery_digitization",
  ],
  [
    // Sprint A2 Correction 2 (Goal 14): "output each screen separately",
    // "make six screen files" and their close variants are unmistakable
    // output requests that the noun-only patterns missed.
    /\b(?:colou?r\s+)?separations?\b|\bseps\b|\bscreen[\s-]ready\b|\bfilm\s+positives?\b|\bspot[\s-]colou?r\s+(?:file|artwork|breakdown)\b|\bpress[\s-]ready\b|\b(?:individual|separate|each)\s+screen\s+(?:file|layer)s?\b|\b\w+\s+screen\s+files?\b|\bscreen\s+files?\b|\b(?:into|for|on)\s+(?:\w+\s+)?screens\b|\beach\s+(?:colou?r|screen)\s+(?:separately|on\s+its\s+own)\b|\bone\s+file\s+per\s+(?:colou?r|screen)\b/i,
    "screen_print_separations",
  ],
  [
    /\b(?:svg|eps|\.ai)\b|\bai\s+file\b|\bvector(?:ize|ized|izing|ised)\b|\bvector\s+(?:file|version|artwork|output|format|production|logo)\b|\boutlined?\s+vectors?\b/i,
    "vector_output",
  ],
  [
    /\bsublimation\s+(?:file|transfer|production|prep(?:aration)?)\b|\bsublimation[\s-]ready\b/i,
    "sublimation_specific",
  ],
];

/**
 * A verb that directs the act AT US. Required — an artifact noun alone is
 * never a request, which is what keeps every descriptive, possessive, and
 * incidental mention out.
 */
const REQUEST_VERB =
  /\b(?:make|create|creating|prepare|preparing|produce|generate|build|send|give|provide|deliver|export|output|convert|separate|split|need|want|require|can\s+you|could\s+you|would\s+you|please|i'?d\s+like|i\s+would\s+like|how\s+about)\b/i;

/**
 * `digitize` is the one artifact term that is itself a verb, so it can stand
 * alone as a request — but only when it is genuinely DIRECTED ("digitize
 * this", "please digitize it"), never when it is the subject of a statement
 * ("digitizing is our business", "digitizing costs extra").
 */
const DIRECTED_DIGITIZE =
  /\bdigitiz(?:e|ing)\b(?!\s+(?:is|are|was|were|costs?|services?))(?=\s+(?:this|it|that|these|those|the|my|our|for|to)\b)|\b(?:please|can\s+you|could\s+you|need\s+you\s+to|want\s+you\s+to)\s+\w{0,12}\s?digitiz/i;

// ---------------------------------------------------------------------------
// Disqualifiers — every one of these is a Codex-found false positive
// ---------------------------------------------------------------------------

/** "no separations", "don't digitize", "without vector files", "never". */
const NEGATION =
  /\b(?:no|not|don'?t|do\s+not|doesn'?t|won'?t|will\s+not|never|without|skip|avoid|isn'?t|aren'?t|neither|nor|rather\s+than|instead\s+of)\b/i;

/** The customer ALREADY HAS it, or is telling us where their file came from. */
const POSSESSION =
  /\b(?:already\s+(?:have|has|got|own)|i\s+have|we\s+have|i've\s+got|we've\s+got|my\s+own|our\s+own|came\s+from|comes\s+from|was\s+made\s+from|taken\s+from|existing)\b/i;

/** It is an INPUT they are giving us, not an output they want back. */
const REFERENCE_OR_SUPPLIED =
  /\b(?:as\s+a\s+reference|for\s+reference|reference\s+only|just\s+a\s+reference|i\s+uploaded|we\s+uploaded|i'?m\s+uploading|attached|attachment|i\s+sent|here'?s\s+my|this\s+is\s+my|based\s+on\s+(?:this|my|our))\b/i;

/** A company, not an instruction — "Screen Print Separations LLC". */
const BUSINESS_NAME =
  /\b(?:llc|l\.l\.c|inc\b|inc\.|incorporated|corp\b|corp\.|corporation|ltd\b|ltd\.|limited|co\.|company|shop|studio|works|brand|team|club|league)\b/i;

/** A statement about a business/service rather than a request to us. */
const PREDICATE_NOT_REQUEST =
  /\b(?:is\s+our|are\s+our|is\s+my|we\s+do|we\s+offer|we\s+specialize|our\s+business|our\s+specialty|our\s+service)\b/i;

const DISQUALIFIERS = [
  NEGATION,
  POSSESSION,
  REFERENCE_OR_SUPPLIED,
  BUSINESS_NAME,
  PREDICATE_NOT_REQUEST,
];

// ---------------------------------------------------------------------------

/**
 * Removes quoted spans — straight quotes, smart quotes, and ALL-CAPS runs of
 * two or more words.
 *
 * Quoted text is the customer's ARTWORK WORDING, never an instruction to us:
 * a shirt that reads "COLOR SEPARATIONS" or "DON'T DIGITIZE ME" is a design,
 * and reading it as a production order is exactly the confusion this whole
 * correction exists to end. The ALL-CAPS rule matters because customers
 * routinely give shirt wording unquoted and in caps.
 */
export function stripQuotedAndShoutedText(message: string): string {
  return message
    .replace(/"[^"]*"/g, " ")
    .replace(/'[^']{3,}'/g, " ")
    .replace(/[“”][^“”]*[“”]/g, " ")
    .replace(/[‘’][^‘’]{3,}[‘’]/g, " ")
    .replace(/\b[A-Z][A-Z0-9''-]{1,}(?:\s+[A-Z][A-Z0-9''-]{1,})+\b/g, " ")
    // Sprint A2 Correction 2 (Goal 13): filenames name a file the customer
    // HAS, not an action they want. See `FILENAME_PATTERN`.
    .replace(FILENAME_PATTERN, " ");
}

/**
 * An explicit affirmation of the SUPPORTED output, including retraction of a
 * previous unsupported request.
 *
 * Checked against the whole message rather than clause-by-clause, and before
 * the disqualifiers, because retractions are inherently negative sentences
 * ("never mind the separations") that the negation guard would otherwise
 * throw away — leaving a customer permanently unable to finalize, which is
 * the exact class of bug this correction exists to remove. A customer must
 * always be able to un-ask, even with the semantic layer offline.
 */
const ARTIFACT_WORD_FOR_RETRACTION =
  "(?:separations?|seps|digitiz\\w*|vector\\w*|dst|svg|eps|sublimation|screen\\s+files?|stitch\\s+files?|embroidery\\s+files?)";

const PNG_AFFIRMATION_PATTERNS = [
  /\b(?:just|only)\s+(?:give\s+me\s+)?(?:the\s+|a\s+|me\s+the\s+)?(?:png|raster(?:\s+file)?|production\s+png|print[\s-]ready\s+file)\b/i,
  /\b(?:png|raster|production\s+png)\s+(?:is|will\s+be)\s+(?:fine|good|enough|all\s+i\s+need|perfect|ok(?:ay)?)\b/i,
  /\b(?:never\s+mind|nevermind|forget|cancel|scratch|disregard|skip|drop)\s+(?:the\s+|that\s+|those\s+|any\s+)?ARTIFACT\b/i,
  // Sprint A2 Correction 2 (Goal 13): explicit changes of mind that the
  // negation guard would otherwise silently discard, stranding the project.
  /\b(?:don'?t|do\s+not)\s+\w{0,12}\s?(?:digitiz\w*|vectoriz\w*|separate)\b.{0,24}\b(?:after\s+all|any\s?more|anymore|instead)\b/i,
  /\b(?:after\s+all|any\s?more|anymore)\b.{0,24}\b(?:don'?t|do\s+not)\s+\w{0,12}\s?(?:digitiz\w*|vectoriz\w*|separate)\b/i,
  /\b(?:i\s+)?changed\s+my\s+mind\b.{0,40}\b(?:raster|png)\b/i,
  /\braster\s+only\b|\bpng\s+only\b|\bonly\s+(?:the\s+)?raster\b/i,
].map((pattern) =>
  pattern.source.includes("ARTIFACT")
    ? new RegExp(pattern.source.replace("ARTIFACT", ARTIFACT_WORD_FOR_RETRACTION), "i")
    : pattern,
);

/**
 * Sprint A2 Correction 2 (Goal 13): a FILENAME is a thing the customer
 * possesses and is handing us, never an instruction. `create-a-dst.png`,
 * `make_separations_v2.ai`, `vectorize-this.jpg` all read as commands once
 * the punctuation is ignored, which is exactly the mistake to avoid.
 *
 * Stripped before analysis rather than merely disqualified, so a real
 * request in the same sentence still lands: "here's logo-vector-final.png,
 * can you make the color separations" is a separations request whose
 * filename must not be part of the reading.
 */
const FILENAME_PATTERN =
  /\b[\w][\w.-]*\.(?:png|jpe?g|gif|webp|svg|eps|ai|pdf|psd|tiff?|dst|pes|exp|zip)\b/gi;

/**
 * Sentence/contrast boundaries. The `.` half is decimal-safe
 * (`lib/domain/clause-boundaries.ts`) so a size the customer states
 * ("a 12.75\" wide PNG") stays in one clause rather than splitting mid-number
 * and separating the request from its own disqualifier check.
 */
const PRODUCTION_CLAUSE_BOUNDARY_PATTERN = new RegExp(
  `(?:${clauseBoundarySource(".!?;\n")})+|\\bbut\\b|\\bhowever\\b|\\bthough\\b`,
  "i",
);

/** Clause-level so a disqualifier in one sentence cannot mask a request in another — and vice versa. */
function toClauses(text: string): string[] {
  return text
    .split(PRODUCTION_CLAUSE_BOUNDARY_PATTERN)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/**
 * Deterministically detects an EXPLICIT request for a production artifact.
 * Returns `null` — meaning "say nothing, let the semantic layer or the
 * existing stored value stand" — for anything short of unmistakable.
 */
export function detectRequestedProductionOutput(
  message: string | null | undefined,
): RequestedProductionOutput | null {
  const raw = message?.trim();
  if (!raw) return null;

  const text = stripQuotedAndShoutedText(raw);

  // Retraction / affirmation of the supported output wins outright.
  if (PNG_AFFIRMATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return "production_png";
  }

  for (const clause of toClauses(text)) {
    if (DISQUALIFIERS.some((pattern) => pattern.test(clause))) continue;

    const directedDigitize = DIRECTED_DIGITIZE.test(clause);
    const hasRequestVerb = REQUEST_VERB.test(clause);
    if (!hasRequestVerb && !directedDigitize) continue;

    for (const [pattern, output] of ARTIFACT_PATTERNS) {
      if (!pattern.test(clause)) continue;
      // A bare `digitize` satisfies the artifact test; require that it was
      // also DIRECTED, so "we need embroidery digitizing prices" does not
      // read as "digitize this for me".
      if (output === "embroidery_digitization" && !directedDigitize) {
        const namesAStitchArtifact =
          /\b(?:dst|pes|exp|jef|vp3|hus|pec)\b|\bembroidery\s+(?:file|format)\b|\bmachine\s+embroidery\b|\bstitch\s+(?:file|out)\b/i.test(
            clause,
          );
        if (!namesAStitchArtifact) continue;
      }
      return output;
    }
  }

  return null;
}
