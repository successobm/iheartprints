/**
 * Where one clause or sentence ends and the next begins, in customer free
 * text.
 *
 * THE INVARIANT: a numeric decimal point is lexical content, not a sentence
 * boundary.
 *
 * THE PROVEN FAILURE. Live acceptance, A4 funnel. The customer wrote:
 *
 *   "black 2010 jeep wrangler unlimited with full racks and an inspired
 *    overland roof top tent, large wheels with a 2.5" lift at the beach with
 *    the sun setting"
 *
 * and the brief stored
 *
 *   "black 2010 jeep wrangler unlimited with full racks and an inspired
 *    overland roof top tent, large wheels with a 2"
 *
 * because every clause/sentence splitter in the extraction path treated the
 * period inside `2.5` as punctuation. The lift, the beach and the sunset were
 * gone before any concept was generated — silent loss of customer creative
 * detail, with nothing in the conversation to show it had happened.
 *
 * The rule here is deliberately LEXICAL. It asks only what characters sit on
 * either side of the period — never whether a measurement noun, a unit, a
 * version keyword or a product name is nearby — so `2.5" lift`,
 * `1.5 inch border`, `Version 2.5`, `Model 3.5`, `a 1.25 ratio` and
 * `198.5 degrees` all survive by one rule instead of a growing list of
 * special cases.
 *
 * Every module that splits customer text into clauses or sentences must go
 * through this file, so the rule cannot drift back into place one duplicated
 * character class at a time. See ARCHITECTURE.md §13j.
 */

/**
 * A `.` acting as punctuation — every period EXCEPT one sitting between two
 * digits.
 *
 * Both alternatives are needed, and neither alone is correct.
 * `(?<!\d)\.` on its own would also refuse the sentence-ending period of
 * "Model 3.5. No text.", which is preceded by a digit; `\.(?!\d)` on its own
 * would do the same for a sentence that begins with a number. A period is
 * content only when it is BOTH preceded and followed by a digit, which is
 * precisely the case where neither alternative can match.
 */
const PUNCTUATION_PERIOD_SOURCE = "(?:(?<!\\d)\\.|\\.(?!\\d))";

/** The one period a clause BODY may contain: the decimal point itself. */
const DECIMAL_POINT_SOURCE = "(?<=\\d)\\.(?=\\d)";

/** `] \ ^ -` are the only characters that need escaping inside `[...]`. */
function escapeForCharacterClass(marks: string): string {
  return marks.replace(/[\\\]^-]/g, "\\$&");
}

/**
 * Regex source matching ONE clause boundary drawn from `marks` — a plain
 * string of punctuation characters, written exactly as it would have been
 * inside a character class (e.g. `".!?;"`).
 *
 * A `.` in `marks` becomes the decimal-safe period rule; every other mark
 * keeps its ordinary literal meaning.
 */
export function clauseBoundarySource(marks: string): string {
  const others = [...marks].filter((mark) => mark !== ".");
  const alternatives: string[] = [];
  if (marks.includes(".")) alternatives.push(PUNCTUATION_PERIOD_SOURCE);
  if (others.length > 0) {
    alternatives.push(`[${escapeForCharacterClass(others.join(""))}]`);
  }
  if (alternatives.length === 0) {
    throw new Error("clauseBoundarySource requires at least one punctuation mark");
  }
  return alternatives.length === 1 ? alternatives[0] : `(?:${alternatives.join("|")})`;
}

/**
 * Regex source for a run of characters that stops at real punctuation — the
 * negated-character-class counterpart of `clauseBoundarySource`, for the
 * capture groups (`([^.!?]+)`, `[^.,;!?\n]+?`) that bound themselves rather
 * than splitting.
 *
 * `excluded` is character-class source written exactly as it would have
 * appeared inside `[^...]`. Quantify at the call site:
 * `` `${clauseBodySource(".!?")}+` ``.
 */
export function clauseBodySource(excluded: string): string {
  return `(?:[^${excluded}]|${DECIMAL_POINT_SOURCE})`;
}

/**
 * Splits `text` on every real boundary in `marks`, leaving decimals intact.
 *
 * Consecutive boundaries collapse into one — every caller either filters
 * empty segments or reads only the first one, so this matches the behavior
 * the duplicated `split(/[.!?]/)` / `split(/[.!?;]+/)` calls already had.
 */
export function splitOnClauseBoundaries(
  text: string | null | undefined,
  marks: string,
): string[] {
  return (text ?? "").split(new RegExp(`(?:${clauseBoundarySource(marks)})+`, "g"));
}
