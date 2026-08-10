/**
 * Detailed-Description Fidelity (Phase 1): the one place the system reads a
 * customer's own design description and answers three questions that every
 * downstream layer needs, and that every downstream layer used to answer
 * differently (or not at all):
 *
 *   1. Does the required content involve MORE THAN ONE element, or a stated
 *      relationship between elements? (`requiresScene`)
 *   2. Did the customer state WHERE things go? (`hasExplicitComposition`,
 *      `compositionStatements`)
 *   3. Did the customer ask for a real place to be reproduced accurately?
 *      (`requestsRealWorldReference`)
 *
 * The Discovery Bay live acceptance audit proved the cost of not having
 * this: a concept direction was free to say "no scene / single small icon"
 * while the approved brief required a lighthouse, a marina, homes, three
 * boat types and a T-shaped waterway, and the provider prompt's default
 * "centered composition" quietly competed with "lighthouse on the left".
 * Neither layer had any way to know the difference.
 *
 * DELIBERATELY NOT A SCHEMA. Nothing here is persisted, and nothing here
 * replaces `DesignBrief.designDescription` — the description itself remains
 * the authoritative customer content contract (see `ARCHITECTURE.md`,
 * "Customer content is authoritative"). This module only *reads* it, purely
 * and deterministically, to make treatment decisions that must not
 * contradict it. There is no scene graph, no `requiredVisualElements[]`, and
 * no structured element list, because the audit established the free-text
 * description can carry the contract on its own.
 *
 * Generic by construction: every pattern below is plain English structure
 * (position words, shape words, enumeration) — there are no Discovery Bay,
 * nautical, vehicle, or any other subject-specific keywords anywhere in this
 * file, and none may be added.
 */

/**
 * Words that state WHERE something sits, or how it relates to something
 * else. A single one of these in a design description means the customer has
 * expressed a compositional requirement, which outranks every default and
 * every creative direction's own layout preference.
 *
 * "front" only ever appears here as part of "in front of" — a bare "front"
 * is far more often the front of an object (or a print placement) than a
 * position within the artwork.
 */
const SPATIAL_TERM_PATTERN =
  /\b(?:left|right|top|bottom|upper|lower|above|below|beneath|underneath|under|over|behind|in front of|front of|foreground|background|backdrop|beside|alongside|next to|adjacent|between|around|surrounding|encircling|across|along|opposite|facing|toward|towards|centered|centred|centre|center|middle|corner|edge|either side|side|diagonal|diagonally|horizontal|horizontally|vertical|vertically|north|south|east|west|overhead|on top of|wrapping|flanking|framing|nearby|near|far)\b/i;

/**
 * Shape/arrangement descriptors — "water in a T shape", "an L-shaped dock",
 * "arranged in a circle". These are compositional requirements too: they
 * describe the form the content must read as, not a style preference.
 */
const SHAPE_TERM_PATTERN =
  /\b(?:[a-z]-shaped|[a-z] shape|shaped like|in the shape of|shape of|circular|rectangular|triangular|oval|arched|curved|winding|forming a|arranged in)\b/i;

/**
 * Nouns that name a multi-element depiction outright. A "skyline" or a
 * "landscape" is never a single icon, whatever a creative direction would
 * prefer.
 */
const SCENE_TERM_PATTERN =
  /\b(?:scene|scenery|landscape|seascape|cityscape|skyline|panorama|panoramic|waterfront|shoreline|coastline|horizon|vista|overview|layout)\b/i;

/**
 * Cues that the customer wants a REAL place reproduced faithfully. Phase 1
 * cannot look anything up, so this exists purely so the provider prompt can
 * be HONEST about that rather than silently dropping the request or
 * pretending to map accuracy. Reference-image grounding is a later phase.
 *
 * Split into a strong standalone cue and a reality+place pairing so that an
 * ordinary "accurate lettering" or a place name on its own never trips it.
 */
const STRONG_GEO_CUE_PATTERN =
  /\b(?:aerial (?:view|photo|photograph|shot|image|map|perspective)|bird'?s[- ]eye|satellite (?:view|image|photo|map)|google (?:maps|earth)|street view|map of|topographic|topographical)\b/i;
const REALITY_CUE_PATTERN =
  /\b(?:actual|real|real[- ]life|real[- ]world|true to life|accurate|accurately|authentic|as it (?:really )?(?:is|looks)|the way it (?:really )?looks|look(?:s)? like the real)\b/i;
const PLACE_CUE_PATTERN =
  /\b(?:area|place|location|layout|geography|geographic|geographical|map|town|city|village|neighborhood|neighbourhood|island|bay|harbor|harbour|coast|coastline|region|county|street|streets|lake|river|delta|waterway|waterways|landmark|landmarks|skyline)\b/i;

/**
 * Boundaries that separate one required element from the next. Used only to
 * COUNT distinct required elements — never to extract them as structured
 * data (Phase 1 is deliberately schema-light).
 */
const ELEMENT_BOUNDARY_PATTERN =
  /,|\band\b|\bplus\b|\balong with\b|\bas well as\b|\bwith\b|\bfeaturing\b|\bincluding\b|\bnext to\b|\bbeside\b|\bbehind\b|\bin front of\b|\babove\b|\bbelow\b|\bunder\b|\bover\b|\bsurrounded by\b/i;

/** Clause boundaries for pulling out the customer's own composition statements. */
const COMPOSITION_CLAUSE_BOUNDARY_PATTERN = /[.;!?]+|,|\bwith\b/i;

/**
 * Words that carry no design content of their own — conversational filler,
 * grammar, and words naming the artifact being made rather than anything in
 * it. Shared with the Conversation Understanding fidelity check
 * (`intent-extraction/preserve-design-detail.ts`) so "did this survive?" and
 * "is this an element?" never use two different definitions of a word that
 * matters.
 *
 * Deliberately contains no position word, no shape word, and no subject
 * noun — removing one of those is exactly the information loss this whole
 * change exists to prevent.
 */
const FILLER_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "so", "of", "to", "for",
  "from", "in", "on", "at", "by", "as", "is", "are", "was", "were", "be",
  "been", "being", "am", "do", "does", "did", "it", "its", "that", "this",
  "these", "those", "there", "here", "we", "i", "you", "me", "my", "our",
  "your", "their", "them", "they", "he", "she", "his", "her", "him", "would",
  "could", "should", "can", "will", "want", "wanted", "like", "liked",
  "think", "thinking", "thought", "maybe", "please", "just", "really",
  "kind", "sort", "thing", "things", "some", "any", "all", "very", "more",
  "most", "also", "too", "put", "putting", "place", "placed", "placing",
  "show", "shows", "showing", "shown", "make", "makes", "making", "made",
  "create", "creates", "creating", "created", "build", "generate", "produce",
  "add", "adds", "adding", "include", "includes", "included", "have", "has",
  "had", "get", "gets", "need", "needs", "going", "go", "goes", "went",
  "turn", "turns", "turning", "look", "looks", "looking", "see", "seeing",
  "about", "something", "anything", "one", "lets", "let", "design", "designs",
  "artwork", "art", "graphic", "graphics", "image", "images", "imagery",
  "picture", "pictures", "photo", "photos", "drawing", "drawings",
  "illustration", "illustrations", "sketch", "logo", "logos", "concept",
  "concepts", "mockup", "shirt", "tshirt", "t-shirt", "shirts", "hoodie",
  "hoodies", "tee", "tees", "print", "printed", "printing",
]);

export interface DesignContentContract {
  /**
   * The customer's own description, verbatim and untouched — the
   * authoritative content contract. Everything else on this object is a
   * derived READING of it, never a replacement for it.
   */
  description: string;
  /**
   * The customer's own composition/placement statements, in their own
   * words, lightly trimmed. Derived by selecting the clauses of
   * `description` that carry a position or shape term — never invented, and
   * never structured data pretending to be a scene graph.
   */
  compositionStatements: string[];
  /** How many distinct required elements the description enumerates (≥1). */
  requiredElementCount: number;
  /**
   * The required content is a multi-element depiction or states a
   * relationship between elements. A creative direction may simplify HOW
   * such content is drawn; it may never reduce it to a lone symbol.
   */
  requiresScene: boolean;
  /**
   * The customer stated where things go. Generic "centered composition"
   * defaults must be withdrawn — see `openai-concept-provider.ts`.
   */
  hasExplicitComposition: boolean;
  /**
   * The customer asked for a real place to be reproduced faithfully. Phase 1
   * has no reference grounding, so the request is preserved and answered
   * honestly rather than dropped or over-claimed.
   */
  requestsRealWorldReference: boolean;
}

/**
 * Reads a design description. Pure, deterministic, allocation-only — no I/O,
 * no provider knowledge, no persistence.
 *
 * `additionalContext` (the brief's additional instructions) is consulted for
 * the real-world-reference request ONLY: a customer's "make it look like the
 * actual area" often lands in notes rather than the design description,
 * while composition and element counting stay anchored to the design
 * description so unrelated notes can never inflate the content contract.
 */
export function analyzeDesignContent(
  description: string | null | undefined,
  options: { additionalContext?: string | null } = {},
): DesignContentContract {
  const text = (description ?? "").trim();
  const context = (options.additionalContext ?? "").trim();

  const compositionStatements = extractCompositionStatements(text);
  const hasExplicitComposition =
    SPATIAL_TERM_PATTERN.test(text) || SHAPE_TERM_PATTERN.test(text);
  const requiredElementCount = countRequiredElements(text);
  const requiresScene =
    requiredElementCount >= 2 ||
    hasExplicitComposition ||
    SCENE_TERM_PATTERN.test(text);

  return {
    description: text,
    compositionStatements,
    requiredElementCount,
    requiresScene,
    hasExplicitComposition,
    requestsRealWorldReference:
      requestsRealWorldReference(text) || requestsRealWorldReference(context),
  };
}

function requestsRealWorldReference(text: string): boolean {
  if (!text) return false;
  if (STRONG_GEO_CUE_PATTERN.test(text)) return true;
  return REALITY_CUE_PATTERN.test(text) && PLACE_CUE_PATTERN.test(text);
}

function extractCompositionStatements(text: string): string[] {
  if (!text) return [];
  const statements: string[] = [];
  for (const raw of text.split(COMPOSITION_CLAUSE_BOUNDARY_PATTERN)) {
    const clause = (raw ?? "").trim().replace(/^(?:and|then|so)\s+/i, "").trim();
    if (!clause) continue;
    if (!SPATIAL_TERM_PATTERN.test(clause) && !SHAPE_TERM_PATTERN.test(clause)) {
      continue;
    }
    // A clause that is nothing but a position word ("on the left") states no
    // relationship on its own and would read as a bullet with no subject.
    if (designContentTokens(clause).length === 0) continue;
    statements.push(clause);
  }
  return dedupeCaseInsensitive(statements);
}

function countRequiredElements(text: string): number {
  if (!text) return 0;
  const segments = text
    .split(ELEMENT_BOUNDARY_PATTERN)
    .map((segment) => (segment ?? "").trim())
    .filter((segment) => designContentTokens(segment).length > 0);
  return Math.max(segments.length, text ? 1 : 0);
}

/**
 * The content-bearing words of a phrase: filler removed, punctuation
 * stripped, single characters and bare numbers dropped. Exported because the
 * fidelity check in `intent-extraction/preserve-design-detail.ts` must use
 * exactly the same notion of "a word that carries design content".
 */
export function designContentTokens(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9'’-]+/)
    .map((word) => word.replace(/^[''’-]+|[''’-]+$/g, ""))
    .filter(
      (word) => word.length >= 2 && !/^\d+$/.test(word) && !FILLER_WORDS.has(word),
    );
}

/**
 * A deliberately light stem so "homes"/"home", "shaped"/"shape" and
 * "boats"/"boat" compare equal. Not a linguistic stemmer — just enough
 * inflection tolerance that a faithful synthesis is not reported as lossy
 * over a plural.
 */
export function stemToken(word: string): string {
  let stem = word;
  if (stem.length > 4 && stem.endsWith("ing")) stem = stem.slice(0, -3);
  else if (stem.length > 4 && stem.endsWith("ed")) stem = stem.slice(0, -2);
  else if (stem.length > 4 && stem.endsWith("es")) stem = stem.slice(0, -2);
  else if (stem.length > 3 && stem.endsWith("s")) stem = stem.slice(0, -1);
  if (stem.length > 3 && stem.endsWith("e")) stem = stem.slice(0, -1);
  return stem;
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
