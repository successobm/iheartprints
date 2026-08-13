/**
 * True Source-Image Targeted Revision: the customer's own revision
 * instruction, split into the distinct changes it actually asks for.
 *
 * A targeted revision is defined as SOURCE ARTWORK + REQUESTED DELTA, so
 * the delta has to survive as the customer expressed it. The Design Brief
 * holds *state* ("the design is a red badge"), never the *change* ("change
 * it to a shield"), and `RegenerationPlan` only knows which brief sections
 * were touched — its descriptions are canned section-level sentences. This
 * module is the one place that turns a literal instruction into discrete,
 * provider-neutral requested changes.
 *
 * Deliberately generic: sentence-shape and a generic change-verb lexicon
 * only, never product/domain nouns, so it never grows a per-scenario
 * keyword list (same rule `shared/revision-intent.ts` follows).
 *
 * Pure — no I/O, no clock, no model call. Used by both Prompt Translation
 * (to build the edit delta) and the revision acknowledgement (so the
 * customer is told back the change they asked for, not the brief fields it
 * happened to touch).
 */

/**
 * Generic imperative verbs that begin a design-change clause. Superset of
 * `intent-extraction`'s `DESIGN_CHANGE_IMPERATIVE_PATTERN` — this module
 * needs to recognize a *continuation* clause ("...and lose the sunset"),
 * which is a weaker signal than deciding a whole message is a revision.
 */
const CHANGE_VERB_PATTERN =
  /^(?:make|change|remove|add|increase|decrease|enlarge|shrink|move|replace|swap|update|adjust|resize|use|put|turn|delete|drop|lose|shift|centre|center|align|brighten|darken|lighten|rework|redo|keep|give|take|get rid of|switch|flip|rotate|straighten|widen|narrow|thicken|thin|soften|sharpen|simplify|clean up|tone down|bump up)\b/i;

/**
 * Polite scaffolding around an instruction. Stripped so a clause reads as a
 * bare imperative ("make the border red"), which is what both the edit
 * prompt and the "I'll ..." acknowledgement need.
 */
const POLITE_PREFIX_PATTERN =
  /^(?:and\s+|also\s+|then\s+|plus\s+|please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|will\s+you\s+|i(?:'|’)?d\s+like\s+(?:you\s+to\s+)?|i\s+want\s+(?:you\s+to\s+)?|i\s+need\s+(?:you\s+to\s+)?|let(?:'|’)?s\s+|lets\s+|maybe\s+|just\s+)+/i;

const TRAILING_POLITE_PATTERN = /[\s,]*\bplease\b[\s.!]*$/i;

/**
 * Clause connectors. Captured (not discarded) so a segment that is NOT its
 * own change ("make it black and white") can be stitched back onto the
 * clause it belongs to instead of becoming a bogus second change.
 */
const CONNECTOR_PATTERN = /\s*(,|;|\band\b|\balso\b|\bthen\b|\bplus\b)\s*/gi;

/** Upper bound so a rambling message can never explode the edit prompt. */
const MAX_REQUESTED_CHANGES = 6;

/**
 * Live Acceptance Cleanup: a BLANKET preservation clause — the customer
 * saying, in their own words, "and change nothing else".
 *
 * The live failure this exists for: "make the 3 SONS text the same color as
 * the ball, everything else stays the same" arrived as ONE requested change
 * with the preservation clause glued onto the end of it, so the strongest
 * signal in the whole message ("change nothing else") reached the provider
 * as part of the change description rather than as a constraint on it.
 *
 * Recognized generically by sentence shape — "everything/anything/nothing
 * else ... the same/unchanged/alone", "keep/leave the rest ...", "don't
 * change anything else", "no other changes". Never a product noun, never a
 * per-scenario keyword (same rule the rest of this module follows).
 */
const BLANKET_PRESERVATION_PATTERN = new RegExp(
  [
    String.raw`\b(?:keep|leave)\s+(?:everything|anything|all)\s+else\b(?:\s+(?:exactly|completely|totally))?(?:\s+(?:the\s+same|alone|unchanged|untouched|as\s+(?:it\s+)?is))?`,
    String.raw`\b(?:keep|leave)\s+the\s+rest\b(?:\s+(?:exactly|completely|totally))?(?:\s+(?:the\s+same|alone|unchanged|untouched|as\s+(?:it\s+)?is))?`,
    String.raw`\b(?:everything|anything|nothing|all)\s+else\b(?:\s+\w+){0,3}?\s+(?:the\s+same|unchanged|untouched|alone|as\s+(?:it\s+)?is)`,
    String.raw`\bthe\s+rest\b(?:\s+\w+){0,3}?\s+(?:the\s+same|unchanged|untouched|alone|as\s+(?:it\s+)?is)`,
    String.raw`\bnothing\s+else\s+(?:changes?|should\s+change|needs?\s+to\s+change)\b`,
    String.raw`\b(?:do\s+not|don'?t|dont)\s+(?:change|touch|alter|modify)\s+(?:anything|any\s?thing|any\s+other|everything|the\s+rest)\b(?:\s+else)?`,
    String.raw`\bno\s+other\s+changes?\b`,
  ].join("|"),
  "i",
);

/** Connector/punctuation left dangling once a blanket clause is removed. */
const TRAILING_CONNECTOR_PATTERN =
  /[\s,;]*\b(?:and|also|but|plus|then|with)\b[\s,;]*$/i;

/**
 * Removes every blanket-preservation clause from one change clause and
 * reports whether any was found. What is left is the customer's actual
 * requested change; the flag becomes a constraint the edit prompt states
 * separately, far more strongly than "…, everything else stays the same"
 * buried inside a change description ever could.
 */
function stripBlanketPreservation(clause: string): {
  text: string;
  matched: boolean;
} {
  let text = clause;
  let matched = false;

  for (;;) {
    const match = BLANKET_PRESERVATION_PATTERN.exec(text);
    if (!match) break;
    matched = true;
    text = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`;
    text = normalizeWhitespace(text)
      .replace(TRAILING_CONNECTOR_PATTERN, "")
      .replace(/^[\s,;]+/, "")
      .replace(/[\s,;]+$/, "");
  }

  return { text: normalizeWhitespace(text), matched };
}

/**
 * One customer revision instruction, decomposed into the two things a
 * targeted edit actually needs: what to change, and how hard the customer
 * asked for everything else to stay put.
 */
export interface RevisionDeltaSplit {
  /** The distinct changes asked for, blanket-preservation language removed. */
  requestedChanges: string[];
  /**
   * The customer explicitly said "everything else stays the same" (or an
   * equivalent). Never inferred from silence — the default preservation
   * contract already covers "anything not listed"; this records that the
   * customer said it out loud, which the edit prompt states as its own
   * hard constraint.
   */
  preserveEverythingElse: boolean;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripPoliteness(value: string): string {
  return normalizeWhitespace(
    value.replace(POLITE_PREFIX_PATTERN, "").replace(TRAILING_POLITE_PATTERN, ""),
  );
}

function stripTerminalPunctuation(value: string): string {
  return value.replace(/[.!?;,\s]+$/g, "").trim();
}

/** Whether a clause reads as a standalone instruction to change the artwork. */
export function isChangeClause(clause: string): boolean {
  return CHANGE_VERB_PATTERN.test(stripPoliteness(clause));
}

/**
 * Splits one literal customer revision instruction into the distinct
 * changes it asks for.
 *
 *   "make the border red and change it to a shield"
 *     → ["make the border red", "change it to a shield"]
 *   "change the font to something more retro and remove the sunset"
 *     → ["change the font to something more retro", "remove the sunset"]
 *   "make the car larger"           → ["make the car larger"]
 *   "make it black and white"       → ["make it black and white"]
 *
 * A connector only starts a new change when what follows it is itself an
 * imperative change clause — otherwise it is part of the clause already in
 * progress ("black and white", "the shield red and the text white").
 *
 * Returns `[]` for an empty instruction. A non-imperative instruction comes
 * back as a single clause: it is still the customer's requested delta, it
 * just is not phrased as a command (callers that need imperative phrasing —
 * the acknowledgement — check `isChangeClause` themselves).
 */
export function splitRequestedChanges(instruction: string): string[] {
  return extractRevisionDelta(instruction).requestedChanges;
}

/**
 * `splitRequestedChanges` plus the blanket-preservation signal — the full
 * decomposition of one instruction. Prefer this wherever the preservation
 * contract matters (Prompt Translation); `splitRequestedChanges` remains
 * the convenience wrapper for callers that only need the change list (the
 * customer-facing acknowledgement).
 */
export function extractRevisionDelta(instruction: string): RevisionDeltaSplit {
  const trimmed = stripTerminalPunctuation(normalizeWhitespace(instruction));
  if (!trimmed) return { requestedChanges: [], preserveEverythingElse: false };

  // `split` with a capturing group yields [seg, conn, seg, conn, seg, ...].
  const parts = trimmed.split(CONNECTOR_PATTERN);
  const clauses: string[] = [];
  let current = parts[0] ?? "";

  for (let i = 1; i < parts.length; i += 2) {
    const connector = parts[i] ?? "";
    const segment = parts[i + 1] ?? "";
    if (!segment.trim()) continue;

    if (isChangeClause(segment)) {
      const finished = stripTerminalPunctuation(stripPoliteness(current));
      if (finished) clauses.push(finished);
      current = segment;
      continue;
    }

    // Not its own instruction — it belongs to the clause in progress.
    current =
      connector === "," || connector === ";"
        ? `${current}${connector} ${segment}`
        : `${current} ${connector} ${segment}`;
  }

  const last = stripTerminalPunctuation(stripPoliteness(current));
  if (last) clauses.push(last);

  // Blanket preservation is stripped LAST, per clause: a clause that was
  // nothing but "everything else stays the same" disappears entirely (it
  // asks for no change at all), and one that merely ended with it keeps
  // only the change the customer actually described.
  let preserveEverythingElse = false;
  const requestedChanges: string[] = [];
  for (const clause of clauses) {
    const stripped = stripBlanketPreservation(clause);
    if (stripped.matched) preserveEverythingElse = true;
    const text = stripTerminalPunctuation(stripped.text);
    if (text) requestedChanges.push(text);
  }

  return {
    requestedChanges: requestedChanges.slice(0, MAX_REQUESTED_CHANGES),
    preserveEverythingElse,
  };
}
