import { COLOR_WORD_PATTERN } from "@/capabilities/shared/color-families";
import { splitOnClauseBoundaries } from "@/lib/domain/clause-boundaries";
import { designContentTokens, stemToken } from "@/lib/domain/design-content-contract";

/**
 * Phase 1.1, Part A — multi-turn design intent.
 *
 * THE PROVEN FAILURE. Live conversation:
 *
 *   Turn 1: "are you familiar with discovery bay california? are you able to
 *            research the light house in the waterways and get idea of the
 *            area and ariel view?"
 *   Turn 2: "I want to show the water way that leads to the marina, with
 *            lighthouse, and the homes that are also there with boats
 *            passing through the channel"
 *
 * Turn 1 populated `designDescription`. Turn 2 REPLACED it wholesale, and
 * Discovery Bay, the real-area/aerial intent, and the waterways context all
 * vanished from the brief. The root cause is structural, not a heuristic
 * miss: `designDescription` has only ever had ASSIGNMENT semantics —
 * `fields.designDescription = <this turn's value>` — and nothing anywhere in
 * the pre-approval path ever asked whether the new turn was ADDING to the
 * design, REFINING part of it, or REPLACING it.
 *
 * This module is that missing question, as a pure function. Three operations:
 *
 *   ADD      "also add homes on the left"   → accumulate
 *   REFINE   "move the lighthouse right"    → supersede the contradicted part
 *   REPLACE  "forget the lighthouse…"       → supersede the prior content
 *
 * DELIBERATELY NOT A SCENE GRAPH. Nothing here is persisted and no schema
 * changes. The merge works on the free-text description at STATEMENT level,
 * using the same generic vocabulary Phase 1 established (position words,
 * shape words, conversational filler) plus attribute dimensions. There are no
 * Discovery Bay, nautical, vehicle, or other subject-specific patterns in
 * this file, and none may be added.
 *
 * It is also NOT the post-selection revision path. That path (`revision-delta`
 * / `revision-intent` / `buildEditPrompt`) assumes a selected `ArtworkVersion`
 * to edit and produces an image-edit delta; this one runs pre-approval, where
 * there is no artwork at all and the only thing to merge is brief text. The
 * classification vocabulary is deliberately similar, the machinery is not
 * shared, and the revision path is untouched.
 */

export type DesignDescriptionUpdateOperation = "add" | "refine" | "replace";

/**
 * Explicit supersede language. Each of these says "what I told you before is
 * no longer what I want" rather than "here is more of what I want".
 *
 * "actually" and "instead" are deliberately NOT sufficient on their own —
 * "actually, also add homes" is an addition, and treating every correction
 * cue as a replacement is how a customer loses their whole design to a
 * clarifying sentence.
 */
const REPLACE_CUE_PATTERN =
  /\b(?:forget(?: about)?|scratch that|never ?mind|start over|start again|from scratch|get rid of|drop the|remove the|take out the|lose the|instead of|no longer|only about|just about|make it (?:just|only)|only make it|make this only)\b/i;

/**
 * Language that changes an element already in the design rather than adding
 * one. Used as a signal only — an actual contradiction between statements is
 * what drives the merge (see `supersedes`), so a refinement phrased without
 * any of these still works.
 */
const REFINE_CUE_PATTERN =
  /\b(?:move|moves|moved|shift|shifted|reposition|relocate|swap|switch|change the|make the|turn the|rotate|flip|resize|bigger|larger|smaller|closer|farther|further)\b/i;

/** Language that plainly signals accumulation. */
const ADD_CUE_PATTERN =
  /\b(?:also|add|adds|adding|include|includes|including|plus|as well|too|along with|and show|and put)\b/i;

/**
 * Attribute dimensions a statement can constrain. Two statements about the
 * same subject only contradict when they constrain the SAME dimension with
 * DIFFERENT values — which is why "make the marina smaller" does not wipe out
 * "marina on the right" (size vs position), while "move the lighthouse to the
 * right" does replace "lighthouse on the left" (position vs position).
 */
const DIMENSION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "position",
    /\b(?:left|right|top|bottom|upper|lower|above|below|beneath|underneath|behind|in front of|front of|foreground|background|backdrop|beside|alongside|next to|adjacent|between|around|surrounding|across|along|opposite|facing|toward|towards|centered|centred|centre|center|middle|corner|edge|either side|side|north|south|east|west|overhead|on top of|flanking)\b/gi,
  ],
  [
    "shape",
    /\b(?:[a-z]-shaped|[a-z] shape|circular|rectangular|triangular|oval|arched|curved|winding|round|square)\b/gi,
  ],
  [
    "size",
    /\b(?:big|bigger|biggest|large|larger|largest|small|smaller|smallest|tiny|huge|oversized|scaled|scale|prominent|dominant)\b/gi,
  ],
  [
    "count",
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|single|pair|several|many|multiple|few|\d+)\b/gi,
  ],
  ["color", new RegExp(COLOR_WORD_PATTERN.source, "gi")],
];

/** Verbs of relocation/alteration — they name the ACT, never the subject. */
const OPERATION_VERBS = new Set([
  "move", "moves", "moved", "moving", "shift", "shifts", "shifted", "shifting",
  "reposition", "repositioned", "relocate", "relocated", "swap", "swapped",
  "switch", "switched", "rotate", "rotated", "flip", "flipped", "resize",
  "resized", "change", "changes", "changed", "forget", "remove", "removed",
  "drop", "dropped", "actually", "instead", "also", "want", "wants", "show",
  "showing", "shown", "shows", "keep", "kept", "still", "now", "then",
]);

/** Restoration/merge output stays a brief, not a transcript. */
const MAX_MERGED_STATEMENTS = 12;

/**
 * Classifies what this customer turn is doing to the existing design
 * description. Pure; message text only, no brief mutation.
 *
 * `incoming` participates because a contradiction is itself strong evidence
 * of a refinement even when the customer used no refinement verb ("lighthouse
 * on the right" following "lighthouse on the left").
 */
export function classifyDesignDescriptionUpdate(
  message: string,
  existing: string | null | undefined,
  incoming: string,
): DesignDescriptionUpdateOperation {
  const text = (message ?? "").trim();
  if (REPLACE_CUE_PATTERN.test(text)) return "replace";

  const priorStatements = splitStatements(existing ?? "");
  const incomingStatements = splitStatements(incoming);
  const contradicts = priorStatements.some((prior) =>
    incomingStatements.some((next) => supersedes(next, prior)),
  );
  if (contradicts) return "refine";
  if (REFINE_CUE_PATTERN.test(text) && priorStatements.length > 0) return "refine";
  if (ADD_CUE_PATTERN.test(text)) return "add";
  return priorStatements.length > 0 ? "add" : "add";
}

/**
 * Produces ONE coherent authoritative design description from the existing
 * one and this turn's value.
 *
 * REPLACE returns the incoming value alone — the customer deliberately
 * superseded what came before, and carrying the old content forward would be
 * ignoring them.
 *
 * ADD and REFINE share a single algorithm, because the difference between
 * them falls out of the content rather than needing its own code path:
 *
 *   1. Drop every existing statement that a new statement CONTRADICTS (same
 *      subject, same attribute dimension, different value) or that a new
 *      statement fully restates. This is what makes "move the lighthouse to
 *      the right" leave exactly ONE lighthouse requirement instead of
 *      "lighthouse on the left; lighthouse on the right".
 *   2. Drop every incoming statement already fully covered by what was kept,
 *      so a customer re-mentioning context they already gave does not
 *      duplicate it.
 *   3. Join what remains.
 *
 * With no contradiction and no overlap, nothing is dropped and the result is
 * simply both — which is the ADD case.
 */
export function mergeDesignDescription(
  existing: string | null | undefined,
  incoming: string,
  message: string,
): string {
  const next = (incoming ?? "").trim();
  const prior = (existing ?? "").trim();
  if (!next) return prior;
  if (!prior) return next;

  const operation = classifyDesignDescriptionUpdate(message, prior, next);
  if (operation === "replace") return next;

  const incomingStatements = splitStatements(next);
  const keptPrior = splitStatements(prior).filter(
    (statement) =>
      !incomingStatements.some(
        (candidate) => supersedes(candidate, statement) || covers(candidate, statement),
      ),
  );

  const keptIncoming = incomingStatements.filter(
    (statement) => !keptPrior.some((kept) => covers(kept, statement)),
  );

  const merged = [...keptPrior, ...keptIncoming].slice(0, MAX_MERGED_STATEMENTS);
  return merged.length > 0 ? merged.map(asSentence).join(" ") : next;
}

/**
 * Sentence-level, with a comma sub-split only when two or more of the comma
 * parts each state a position of their own — the identical rule
 * `preserve-design-detail.ts` uses, and for the same reason: a relationship
 * ("homes behind the lighthouse") only survives if its words stay together,
 * while a genuinely per-element list ("lighthouse left, marina right") needs
 * separating so one element can be superseded without taking the others down
 * with it.
 */
function splitStatements(text: string): string[] {
  const statements: string[] = [];
  for (const sentence of splitOnClauseBoundaries(text, ".!?;")) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const commaParts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
    const positionedParts = commaParts.filter((part) => dimensionsOf(part).size > 0);
    const units = positionedParts.length >= 2 ? commaParts : [trimmed];
    for (const unit of units) {
      const cleaned = unit.replace(/^(?:and|then|so|but|also)\s+/i, "").trim();
      if (!cleaned || subjectTokens(cleaned).length === 0) continue;
      statements.push(cleaned);
    }
  }
  return statements;
}

/**
 * Does `candidate` contradict `prior`? True only when they talk about the
 * same subject AND constrain a shared attribute dimension differently. The
 * shared-dimension requirement is what stops a size change from erasing a
 * position, or a repositioning from erasing a count.
 */
function supersedes(candidate: string, prior: string): boolean {
  if (!sharesSubject(candidate, prior)) return false;
  const candidateDimensions = dimensionValues(candidate);
  const priorDimensions = dimensionValues(prior);
  for (const [dimension, priorValues] of priorDimensions) {
    const candidateValues = candidateDimensions.get(dimension);
    if (!candidateValues || candidateValues.size === 0) continue;
    if (!setsEqual(candidateValues, priorValues)) return true;
  }
  return false;
}

/** Is every content word of `inner` already present in `outer`? */
function covers(outer: string, inner: string): boolean {
  const outerTokens = new Set(designContentTokens(outer).map(stemToken));
  const innerTokens = designContentTokens(inner).map(stemToken);
  if (innerTokens.length === 0) return true;
  return innerTokens.every((token) => outerTokens.has(token));
}

function sharesSubject(a: string, b: string): boolean {
  const aSubjects = new Set(subjectTokens(a));
  return subjectTokens(b).some((token) => aSubjects.has(token));
}

/**
 * The nouns a statement is ABOUT — its content words minus attribute values
 * (a position/size/count/color word describes the subject, it is not the
 * subject) and minus verbs naming the edit itself.
 */
function subjectTokens(statement: string): string[] {
  const attributeValues = new Set<string>();
  for (const values of dimensionValues(statement).values()) {
    for (const value of values) attributeValues.add(value);
  }
  return designContentTokens(statement)
    .filter((token) => !OPERATION_VERBS.has(token))
    .map(stemToken)
    .filter((token) => token.length > 0 && !attributeValues.has(token));
}

function dimensionValues(statement: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const [dimension, pattern] of DIMENSION_PATTERNS) {
    const matches = statement.match(new RegExp(pattern.source, pattern.flags));
    if (!matches || matches.length === 0) continue;
    found.set(
      dimension,
      new Set(matches.map((match) => stemToken(match.toLowerCase().trim()))),
    );
  }
  return found;
}

function dimensionsOf(statement: string): Set<string> {
  return new Set(dimensionValues(statement).keys());
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function asSentence(statement: string): string {
  const capitalized = statement.charAt(0).toUpperCase() + statement.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}
