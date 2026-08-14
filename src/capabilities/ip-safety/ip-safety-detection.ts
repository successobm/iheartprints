/**
 * Sprint A3 — DETECTION. "What does the customer appear to be asking us to
 * create?"
 *
 * Detection answers that question and nothing else. It never decides whether
 * a request may proceed, never posts a message, never touches persistence,
 * and never calls a provider — enforcement is a separate responsibility
 * (`ip-safety-capability.ts`, and the three fences that consume it). Keeping
 * them apart is what stops provider behavior from quietly becoming the
 * product's safety policy.
 *
 * ---------------------------------------------------------------------------
 * THE CENTRAL DISTINCTION
 * ---------------------------------------------------------------------------
 *
 *     THEME / INSPIRATION            vs      REPRODUCTION / IMITATION
 *     "black and silver football"            "the Raiders logo"
 *     "aggressive pirate skull"              "recreate that team's shield"
 *     "generic athletic motion mark"         "use the Nike swoosh"
 *     "vintage Los Angeles basketball"       "make Mickey Mouse in a jersey"
 *
 * ---------------------------------------------------------------------------
 * CORRECTION 1 — SCOPING IS PER-OCCURRENCE, NEVER PER-CLAUSE
 * ---------------------------------------------------------------------------
 *
 * The first implementation cleared an ENTIRE clause whenever a disqualifying
 * word appeared anywhere in it. That is wrong, and it was wrong in the worst
 * direction: an unrelated trailing instruction silently unblocked an
 * explicit reproduction request.
 *
 *     "Make me the Raiders logo, no text."          <- "no" governs "text"
 *     "Make me a Raiders logo and don't add more."  <- "don't" governs "add"
 *     "Use the Nike swoosh, no words."              <- "no" governs "words"
 *
 * A neutralizing operator now has SCOPE: it runs from where it appears to the
 * next scope terminator (`, ; : . ! ?` or a coordinating conjunction), and it
 * neutralizes only the referent occurrences that fall INSIDE that scope. A
 * finding requires a SURVIVING protected referent and a SURVIVING binding —
 * occurrences, not clause-level booleans. Forward scope is also why the
 * canonical safety subject puts the customer's CURRENT instruction first:
 * "remove the logo" must be able to govern the design context that follows
 * it, and "no text" must not reach backwards over the request it trails.
 *
 * These stay allowed, because the operator genuinely governs the referent:
 *
 *     "Don't use the Raiders logo."
 *     "Remove the Nike logo."
 *     "Make this nothing like the Raiders."
 *
 * ---------------------------------------------------------------------------
 * NO CONTEXTUAL "SAFE WORDS"
 * ---------------------------------------------------------------------------
 *
 * `themed`, `vibe`, `feel`, `inspired by`, `I like`, `said`, and the
 * watch-party/discussion vocabulary used to clear a clause outright. They no
 * longer disqualify anything, because they never carried the allow-cases in
 * the first place — "a pirate-themed football shirt" is allowed for the far
 * better reason that it contains no protected referent at all. Removing them
 * closed a whole family of trivially-worded requests:
 *
 *     "Raiders themed, including their shield."
 *     "Same vibe as the Raiders logo."
 *     "Raiders logo inspired."
 *
 * ---------------------------------------------------------------------------
 * PRECISION OVER RECALL, deliberately
 * ---------------------------------------------------------------------------
 *
 * The two failure modes are not symmetric. A false NEGATIVE leaves the
 * provider's own independent safety systems as the next line of defence and
 * a human in the loop after that. A false POSITIVE refuses a paying
 * customer's perfectly ordinary design — a bowling team, a plumbing
 * company's own logo, a pirate-themed football shirt — and there is no way
 * for them to argue with it. So when in doubt this module says nothing.
 *
 * ---------------------------------------------------------------------------
 * NO EVASION COACHING
 * ---------------------------------------------------------------------------
 *
 * Nothing in this module, and nothing derived from it, ever states a
 * threshold ("change it 20%", "make it X% different"). Requests that ask for
 * one are blocked precisely so the product never has to answer them.
 */

import type { IpSafetyFinding, IpSafetyReason } from "./contracts";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/**
 * Nouns that name a BRAND IDENTIFIER rather than ordinary design content.
 *
 * On their own these are completely innocent — "a logo for our bowling team"
 * is the single most common thing customers ask for. They only ever matter
 * once a protected referent survives alongside them.
 */
const MARK_NOUN_SOURCE =
  "\\b(?:logos?|logotypes?|wordmarks?|word\\s+marks?|trademarks?|trade\\s+marks?|brand\\s?marks?|service\\s+marks?|marks?|emblems?|insignias?|crests?|shields?|badges?|mascots?|monograms?|swooshe?s?|roundels?|liver(?:y|ies)|branding)\\b|[™®©]";

/**
 * Explicit statements that the thing referred to is somebody's protected
 * property. Entirely general — these name no brand at all.
 */
const PROTECTION_TOKEN_SOURCE =
  "\\b(?:trademarke?d?|trade\\s+marke?d?|copyrighte?d?|registered\\s+(?:mark|trademark)|intellectual\\s+property|officially\\s+licensed|licensed\\s+(?:brand|character|property|mark))\\b|[™®]";

/**
 * A DELIBERATELY SMALL, EXPLICITLY INCOMPLETE backstop list of widely
 * recognized third-party organizations, leagues, and brands.
 *
 * READ THIS BEFORE ADDING TO IT. This list is NOT the policy, and its
 * absence is never a statement that something is safe:
 *
 *   - It is the deterministic BACKSTOP. The semantic layer
 *     (Conversation Understanding's `ipSignal`) is what generalizes to marks
 *     nobody enumerated; this exists so the boundary still holds with that
 *     layer unconfigured, skipped, or failed.
 *   - A hit here is NEVER sufficient on its own. It must survive operator
 *     scoping, must not be part of a customer business name (see
 *     `BUSINESS_NAME_CONTINUATION`), and must sit alongside a surviving mark
 *     noun, reproduction verb, or imitation cue. That is what keeps "a watch
 *     party for the Raiders", "I like black and silver", and "an
 *     eagles-themed design" out of the blocked set.
 *   - It is not a trademark register, a legal authority, or a claim about
 *     who owns anything.
 */
const PROTECTED_ORGANIZATION_SOURCE =
  "\\b(?:nfl|nba|mlb|nhl|ncaa|mls|fifa|uefa|ufc|wwe|nascar|olympics?|premier\\s+league|raiders?|lakers?|yankees|cowboys|patriots|celtics|dodgers|packers|steelers|knicks|red\\s+sox|49ers|nike|adidas|puma|reebok|under\\s+armour|supreme|gucci|louis\\s+vuitton|chanel|starbucks|coca[\\s-]?cola|pepsi|mcdonald'?s|disney|pixar|marvel|dc\\s+comics|lucasfilm|nintendo|pokemon|playstation|xbox|ferrari|lamborghini|porsche|harley[\\s-]davidson|john\\s+deere)\\b";

/**
 * Protected third-party CHARACTERS and franchise properties. Same backstop
 * caveats as above, with one structural difference: a character does not
 * need a mark noun to be reproduced — "make Mickey Mouse in a football
 * jersey" asks us to draw the character itself.
 *
 * Restricted to distinctive, multi-word or unmistakable names on purpose.
 * Single common words ("mario", "elsa", "hulk") are omitted precisely
 * because they collide with ordinary design vocabulary.
 */
const PROTECTED_CHARACTER_SOURCE =
  "\\b(?:mickey\\s+mouse|minnie\\s+mouse|donald\\s+duck|winnie\\s+the\\s+pooh|spongebob|squarepants|scooby[\\s-]doo|bugs\\s+bunny|daffy\\s+duck|tweety|snoopy|charlie\\s+brown|hello\\s+kitty|pikachu|sonic\\s+the\\s+hedgehog|super\\s+mario|spider[\\s-]?man|iron\\s+man|captain\\s+america|batman|superman|wonder\\s+woman|darth\\s+vader|baby\\s+yoda|grogu|storm\\s?trooper|harry\\s+potter|star\\s+wars|the\\s+grinch|dr\\.?\\s+seuss|paw\\s+patrol|my\\s+little\\s+pony|transformers)\\b";

/**
 * Verbs that name REPRODUCTION as the act itself — distinct from ordinary
 * design imperatives ("make", "create"), because these say what is being
 * made: a copy.
 */
const REPRODUCTION_VERB_SOURCE =
  "\\b(?:recreate|re[\\s-]create|reproduce|replicate|duplicate|clone|copy|copied|copying|redraw|re[\\s-]draw|trace|rip\\s+off|knock\\s+off)\\b";

/**
 * Cues that the customer wants the result to be RECOGNIZABLY THE SAME as
 * something else. These carry the imitation case, where no reproduction verb
 * is used and the mark may not be named as a mark at all.
 */
const IMITATION_CUE_SOURCE =
  "\\b(?:exactly\\s+(?:the\\s+same|like|as)|the\\s+exact\\s+same|same\\s+exact|(?:their|his|her|its)\\s+exact|identical\\s+to|indistinguishable|spot[\\s-]on|dead\\s+ringer|just\\s+like|look\\s+exactly\\s+like|pixel[\\s-]perfect|recognizably|recognizable\\s+as|like\\s+theirs?|same\\s+as\\s+(?:the|their)|inspired\\s+by\\s+the)\\b";

/* ------------------------------------------------------------------ */
/* Evasion                                                             */
/* ------------------------------------------------------------------ */

/**
 * TIER A — self-sufficient evasion vocabulary. These say out loud that the
 * point is to get around somebody's protection, so they need no referent:
 * "make a knockoff version" is an evasion request whether or not a brand is
 * named.
 */
const SELF_SUFFICIENT_EVASION_PATTERNS: RegExp[] = [
  /\bknock[\s-]?offs?\b/i,
  /\bboot[\s-]?legs?\b/i,
  /\bcounterfeits?\b|\bcounterfeiting\b/i,
  /\bavoid(?:ing)?\s+(?:the\s+|a\s+|any\s+)?(?:copyright|trademark|infringement|infringing|lawsuits?|legal\s+(?:trouble|issues?|problems?))\b/i,
  /\b(?:get\s+around|work\s+around|skirt|circumvent|sidestep)\s+(?:the\s+|a\s+|any\s+)?(?:copyright|trademark|ip\b|licensing)/i,
  /\bso\s+(?:that\s+)?(?:it|we|i|they)'?(?:s|re)?\s*(?:is|are)?\s*legal\b/i,
  /\bthat\s+it'?s\s+legal\b/i,
  /\blegally\s+(?:different|distinct|safe|ok(?:ay)?|clear)\b/i,
  /\btechnically\s+(?:different|distinct|legal|ok(?:ay)?|not\s+the\s+same)\b/i,
  /\b(?:don'?t|do\s+not|won'?t|not)\s+get\s+(?:in|into)\s+trouble\b/i,
  /\b(?:without|so\s+we\s+don'?t|so\s+i\s+don'?t|and\s+not)\s+get(?:ting)?\s+sued\b/i,
  /\bwithout\s+(?:making\s+it|being|it\s+being)\s+obvious\b/i,
  /\bso\s+(?:no\s+?one|nobody|no\s+body)\s+(?:notices|knows|can\s+tell)\b/i,
  /\bclose\s+enough\s+(?:that|so|for)\b[^.!?]{0,40}\b(?:know|knows|tell|recognize|recognise|realize)\b/i,
  /\bfly(?:ing)?\s+under\s+the\s+radar\b/i,
  // Correction 1: an explicit percentage of change is evasion phrasing on
  // its own terms — it only ever appears when somebody is trying to measure
  // their way past a protection.
  /\b\d{1,3}\s*(?:%|percent)\s*(?:different|changed|off|altered)\b/i,
  /\b(?:change|alter|tweak|modify|shift)\b[^.!?]{0,40}?\b\d{1,3}\s*(?:%|percent)\b/i,
  // Stripping the protection notice off a mark while keeping the mark.
  /\b(?:remove|removing|take\s+off|taking\s+off|get\s+rid\s+of|delete|erase|strip|drop|omit|leave\s+off)\s+(?:the\s+|any\s+|that\s+)?(?:trademark|trade\s+mark|copyright|registered)\s*(?:symbols?|signs?|marks?|notices?|characters?)?\b/i,
  /\b(?:remove|take\s+off|get\s+rid\s+of|delete|erase|strip|drop|omit|leave\s+off)\s+(?:the\s+|any\s+|that\s+)?[™®©]/i,
];

/**
 * TIER A', suppressed by a SELF-REFERENCE claim.
 *
 * "Almost identical" is evasion phrasing when aimed at somebody else's work
 * and an entirely ordinary request when aimed at the customer's own file
 * ("make my logo almost identical but with the new tagline"). It is
 * self-sufficient — it needs no named brand, which is what catches "don't
 * copy it exactly, just make it nearly identical" — but a self-reference in
 * the same clause takes it back.
 */
const NEAR_IDENTICAL_EVASION =
  /\b(?:almost|nearly|virtually|practically)\s+identical\b/i;

/**
 * TIER B — evasion phrasing that is only evasion once there is something to
 * evade. "Different enough" is meaningless without a referent; alongside a
 * mark it is unmistakable.
 */
const REFERENT_BOUND_EVASION_PATTERNS: RegExp[] = [
  /\b(?:different|distinct|changed|altered|modified)\s+enough\b/i,
  /\bjust\s+enough\b/i,
  /\benough\s+(?:that|so)\s+it'?s\b/i,
  /\b(?:slightly|barely|a\s+little|a\s+bit|marginally)\s+different\b/i,
];

/* ------------------------------------------------------------------ */
/* Neutralizing operators (scoped) and rescues                         */
/* ------------------------------------------------------------------ */

/**
 * Operators that genuinely take back what FOLLOWS them: negation, avoidance,
 * and removal. Each match's scope runs to the next scope terminator, and it
 * neutralizes only the occurrences inside that scope.
 *
 * `original` carries a lookbehind on purpose: "make something original" is
 * the customer asking for original work, while "the original mark" / "their
 * original logo" names the SOURCE being copied and is the opposite.
 */
const NEUTRALIZING_OPERATOR =
  /\b(?:don'?t|do\s+not|doesn'?t|didn'?t|won'?t|will\s+not|can'?t|cannot|shouldn'?t|should\s+not|never|no|not|nothing|none|neither|nor|isn'?t|aren'?t|wasn'?t|without|avoid|avoiding|steer\s+clear\s+of|stay\s+away\s+from|unlike|instead\s+of|rather\s+than|remove|removing|removal|get\s+rid\s+of|delete|erase|strip|omit|leave\s+off|take\s+off|from\s+scratch)\b|(?<!\b(?:the|their|its|his|her|that|this|an?)\s)\boriginals?\b|\btake\b(?=[^,.;:!?]*\boff\b)/gi;

/**
 * Where an operator's authority ends. Punctuation, and the coordinating
 * conjunctions customers use to start a genuinely new instruction — which is
 * exactly why "make me a Raiders logo AND don't add anything else" no longer
 * clears the first half.
 */
const SCOPE_TERMINATOR = /[,;:.!?]|\b(?:and|but|or|then|also|plus|while|just)\b/gi;

/**
 * The customer is asserting the branding is THEIRS. iHeartPrints does not
 * verify that assertion and must never claim to — but a business customer
 * asking for their own branding is the case Goal 6 requires stay usable, and
 * refusing it would make the product unusable for them.
 *
 * NEVER rescues a surviving recognized organization or character: "recreate
 * our Raiders logo", "our Nike swoosh needs to be bigger", and "we own this
 * NFL logo; reproduce it" all stay blocked.
 */
const OWNERSHIP_CLAIM_SOURCE =
  "\\b(?:my|our|mine|ours|we\\s+own|i\\s+own|my\\s+own|our\\s+own|my\\s+compan(?:y|ies)'?s?|our\\s+compan(?:y|ies)'?s?|our\\s+team'?s?|my\\s+team'?s?|our\\s+business|my\\s+business|our\\s+club|my\\s+club)\\b";

const OWNERSHIP_CLAIM = new RegExp(OWNERSHIP_CLAIM_SOURCE, "i");

/** The customer pointing at the file THEY supplied, not at a third party's work. */
const SELF_REFERENCE =
  /\b(?:my|our|mine|ours)\b|\bwhat\s+i\s+(?:uploaded|sent|gave|attached)\b|\bthe\s+(?:file|image|artwork|photo)\s+i\b/i;

/**
 * P1 — BUSINESS-NAME COLLISION.
 *
 * A customer may legitimately run "Raiders Plumbing LLC" or "Supreme
 * Roofing". A recognized token immediately followed by a trade, professional,
 * or legal-entity noun is a BUSINESS NAME, and that occurrence is not a
 * protected referent at all.
 *
 * Occurrence-level, never clause-level: "Raiders Plumbing needs a new
 * Raiders logo" neutralizes only the first one. And deliberately narrow —
 * "logo", "shield", "crest" are not on this list, so "the Raiders logo" is
 * untouched.
 *
 * This is not an ownership or rights determination. It is a reading of
 * sentence structure, and it is the same reading a person would make.
 */
const BUSINESS_NAME_CONTINUATION =
  /^\s*(?:&?\s*\w+\s+)?(?:plumbing|electric(?:al)?|roofing|construction|contracting|contractors?|landscaping|lawn|hvac|heating|cooling|auto|automotive|motors|towing|trucking|hauling|moving|painting|remodeling|flooring|carpentry|masonry|concrete|paving|fencing|welding|manufacturing|industries|industrial|supply|supplies|solutions|services|service|systems|group|holdings|enterprises|partners|associates|consulting|realty|insurance|financial|dental|medical|clinic|pharmacy|veterinary|salon|barbershop|spa|fitness|gym|bakery|cafe|catering|deli|diner|grill|pizzeria|brewing|brewery|distillery|winery|nursery|cleaning|janitorial|laundry|pest|staffing|logistics|transport|transportation|storage|rentals?|leasing|equipment|lumber|septic|drilling|excavating|tattoo|daycare|childcare|llc|l\.l\.c\.?|inc\.?|incorporated|corp\.?|corporation|ltd\.?|limited|co\.|company|pllc|llp)\b/i;

/* ------------------------------------------------------------------ */
/* Text shaping                                                        */
/* ------------------------------------------------------------------ */

/**
 * Clause-level, so a request in one sentence can neither mask nor be masked
 * by another. Deliberately does NOT split on commas: a comma terminates an
 * OPERATOR'S SCOPE (see `SCOPE_TERMINATOR`) but must still allow a referent
 * and its binding to be associated across it, which is what makes the
 * canonical cross-field / cross-turn subject work at all.
 */
function toClauses(text: string): string[] {
  return text
    .split(/[.!?;\n]+|\bhowever\b|\bthough\b|\bexcept\b/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/** Short, bounded internal evidence — never persisted, never surfaced. */
function evidenceOf(clause: string): string {
  const collapsed = clause.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
}

/* ------------------------------------------------------------------ */
/* Occurrence scanning                                                 */
/* ------------------------------------------------------------------ */

interface Span {
  start: number;
  end: number;
}

function findAll(clause: string, source: string): Span[] {
  const pattern = new RegExp(source, "gi");
  const spans: Span[] = [];
  for (const match of clause.matchAll(pattern)) {
    if (match.index === undefined) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/**
 * Forward scopes: each match of `pattern` runs to the next scope terminator
 * at or after its end. Shared by neutralizing operators and by ownership
 * claims — both are things that govern what FOLLOWS them, and both have to
 * stop at the same boundary ("recreate our logo, and copy their badge" is
 * two instructions, and the possessive only reaches the first).
 */
function forwardScopes(clause: string, pattern: RegExp): Span[] {
  const terminators: number[] = [];
  for (const match of clause.matchAll(SCOPE_TERMINATOR)) {
    if (match.index !== undefined) terminators.push(match.index);
  }

  const scopes: Span[] = [];
  for (const match of clause.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const from = match.index;
    const to = terminators.find((index) => index >= match.index! + match[0].length);
    scopes.push({ start: from, end: to ?? clause.length });
  }
  return scopes;
}

/**
 * FULL containment, not "starts inside" (Correction 4).
 *
 * A safe scope explains a span only when it covers ALL of it. Start-only
 * semantics let an evidence quote begin inside a negation and run straight
 * out the other side of it:
 *
 *     "Don't use the old logo, recreate the Fictitious Rovers badge."
 *      |--- scope ends here ---|
 *      quote: "old logo, recreate the Fictitious Rovers badge"
 *              ^ starts inside                              ^ ends outside
 *
 * The tail is the unsafe half, and under start-only matching it was
 * suppressed. Applied identically to neutralizing scopes and to
 * ownership-explained segments.
 */
function fullyContains(scopes: Span[], span: Span): boolean {
  return scopes.some((scope) => span.start >= scope.start && span.end <= scope.end);
}

/**
 * REQUEST SEGMENTS (Correction 3).
 *
 * The stretches between scope terminators. Each one is a single instruction:
 * "recreate our logo" / "then reproduce theirs" are two, and that is exactly
 * why an ownership claim in the first must never reach the second.
 *
 * Offsets are preserved so a segment can be compared against the occurrence
 * spans everything else in this module already works in.
 */
function toSegments(text: string): Span[] {
  const starts: number[] = [0];
  const ends: number[] = [];
  for (const match of text.matchAll(SCOPE_TERMINATOR)) {
    if (match.index === undefined) continue;
    ends.push(match.index);
    starts.push(match.index + match[0].length);
  }
  ends.push(text.length);

  const segments: Span[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const end = ends[index] ?? text.length;
    if (end > start) segments.push({ start, end });
  }
  return segments;
}

/**
 * The segments an OWNERSHIP claim actually explains.
 *
 * Correction 3, Blocker 1: ownership used to be read clause-wide, so
 * "Recreate our logo, then reproduce theirs" let the possessive in the first
 * instruction excuse the reproduction request in the second. A possessive
 * governs its own instruction and nothing beyond it.
 *
 * A segment naming a RECOGNIZED third party is never ownership-explained —
 * "recreate our Raiders logo" is not rescued by "our", exactly as before.
 * iHeartPrints does not verify any ownership claim and never implies it has;
 * honouring the unrecognized ones is a usability decision, not a finding.
 */
function ownershipExplainedSegments(text: string): Span[] {
  const recognized = [
    ...excludeBusinessNames(text, findAll(text, PROTECTED_ORGANIZATION_SOURCE)),
    ...excludeBusinessNames(text, findAll(text, PROTECTED_CHARACTER_SOURCE)),
  ];
  return toSegments(text).filter((segment) => {
    if (!OWNERSHIP_CLAIM.test(text.slice(segment.start, segment.end))) return false;
    return !recognized.some(
      (span) => span.start >= segment.start && span.start < segment.end,
    );
  });
}

function survives(span: Span, scopes: Span[]): boolean {
  return !scopes.some((scope) => span.start >= scope.start && span.start < scope.end);
}

/**
 * Survival for EVASION phrases, which routinely embed their own operator
 * word: "copy this logo WITHOUT making it obvious", "REMOVE the trademark
 * symbol". A scope only takes an evasion phrase back when the operator sits
 * STRICTLY BEFORE it — that is a customer refusing the idea ("don't make a
 * knockoff"), not the idiom containing the word.
 *
 * This is also what makes "Don't copy it exactly, just make it nearly
 * identical" block: the leading negation's scope ends at the comma, so it
 * never reaches the phrase that follows.
 */
function survivesAsEvasion(span: Span, scopes: Span[]): boolean {
  return !scopes.some((scope) => scope.start < span.start && span.start < scope.end);
}

/** First match position of any pattern in the list, or `null`. */
function firstMatch(clause: string, patterns: readonly RegExp[]): Span | null {
  for (const pattern of patterns) {
    const match = pattern.exec(clause);
    if (match?.index !== undefined) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }
  return null;
}

/**
 * Drops recognized-token occurrences that are part of a customer business
 * name. Occurrence-level: only the colliding one is dropped.
 */
function excludeBusinessNames(clause: string, spans: Span[]): Span[] {
  return spans.filter(
    (span) => !BUSINESS_NAME_CONTINUATION.test(clause.slice(span.end)),
  );
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

/**
 * CORRECTION 3 — THE ONE QUESTION THE ENFORCEMENT LAYER ASKS ABOUT SAFETY.
 *
 * "Is the request the semantic layer is worried about the SAME request the
 * customer's own safe wording already took care of?"
 *
 * Earlier corrections answered a weaker question — "is there safe evidence
 * somewhere in this subject?" — and a weaker one still — "is there safe
 * evidence and no surviving deterministic request structure?". Both let safe
 * evidence about ONE request immunize a DIFFERENT one:
 *
 *     "Recreate our logo, then reproduce theirs."
 *      |-- owned, explained --|  |-- someone else's, not explained --|
 *
 *     "Don't use the old logo, draw that famous cartoon mouse exactly."
 *      |----- neutralized -----|  |-- invisible to the lexicon entirely --|
 *
 * The second example is the decisive one: no deterministic signal exists for
 * "that famous cartoon mouse" at all, so no amount of occurrence counting
 * can represent it. The only thing that can locate that request is the
 * semantic signal's own `evidence` quote — a short span of the customer's
 * text, already required by the `IpSafetySignal` contract.
 *
 * So the rule is positional, and it is the smallest general relationship
 * between safe evidence and a semantic finding: the semantic request is
 * explained only when the customer's quoted words sit INSIDE deterministic
 * safe evidence — a neutralizing operator's scope, or an ownership-explained
 * segment.
 *
 * That subsumes any kind-specific rule (Goal 4): a character request is
 * blocked in the decoy sentence not because it is a character, but because
 * it sits outside the scope of the negation that governed the logo. And
 * "Don't use that famous cartoon mouse" is allowed for the same positional
 * reason, with no character lexicon involved.
 *
 * Unlocatable evidence (empty, or paraphrased so it no longer appears in the
 * subject) means safety CANNOT be established, so it does not suppress. That
 * is the conservative direction on a spend boundary, and the provider prompt
 * requires a real quote.
 *
 * CORRECTION 4 — EVERY OCCURRENCE, AND THE WHOLE SPAN.
 *
 * The quote is matched at EVERY position it appears, and suppression requires
 * all of them to be fully explained. Taking only the first match let a safely
 * covered occurrence immunize an identical unsafe one later in the same
 * sentence:
 *
 *     "Don't use the Fictitious Rovers logo, then recreate the Fictitious
 *      Rovers logo."
 *      |----- first: covered -----|         |--- second: not covered ---|
 *
 * Nothing tells us which occurrence the model was looking at, and the model
 * sees the recent-turn window too, so any uncovered occurrence is a request
 * the safe wording does not account for. Requiring all of them is the only
 * reading that cannot be gamed by repetition — in either order.
 */
export function isCoveredBySafeEvidence(
  subject: string | null | undefined,
  quote: string | null | undefined,
): boolean {
  const text = collapseWhitespace(subject ?? "");
  const needle = collapseWhitespace(quote ?? "");
  if (!text || !needle) return false;

  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  const scopes = forwardScopes(text, NEUTRALIZING_OPERATOR);
  const ownership = ownershipExplainedSegments(text);

  let found = false;
  for (let at = haystack.indexOf(target); at >= 0; at = haystack.indexOf(target, at + 1)) {
    found = true;
    const span: Span = { start: at, end: at + needle.length };
    if (!fullyContains(scopes, span) && !fullyContains(ownership, span)) {
      return false;
    }
  }
  return found;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Deterministically detects requests to reproduce, imitate, or evade
 * protection on third-party branding. Returns no findings for anything short
 * of unmistakable.
 */
export function detectProtectedIpRisk(
  subjects: readonly (string | null | undefined)[],
): IpSafetyFinding[] {
  const findings: IpSafetyFinding[] = [];
  const seen = new Set<string>();

  for (const subject of subjects) {
    const text = subject?.trim();
    if (!text) continue;

    const subjectHasReferent =
      new RegExp(MARK_NOUN_SOURCE, "i").test(text) ||
      new RegExp(PROTECTION_TOKEN_SOURCE, "i").test(text) ||
      new RegExp(PROTECTED_ORGANIZATION_SOURCE, "i").test(text) ||
      new RegExp(PROTECTED_CHARACTER_SOURCE, "i").test(text);

    for (const clause of toClauses(text)) {
      for (const finding of inspectClause(clause, subjectHasReferent)) {
        const key = `${finding.reason}:${finding.evidence}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(finding);
      }
    }
  }

  return findings;
}

function inspectClause(clause: string, subjectHasReferent: boolean): IpSafetyFinding[] {
  const findings: IpSafetyFinding[] = [];
  const scopes = forwardScopes(clause, NEUTRALIZING_OPERATOR);

  const allOrganizations = excludeBusinessNames(
    clause,
    findAll(clause, PROTECTED_ORGANIZATION_SOURCE),
  );
  const allCharacters = excludeBusinessNames(
    clause,
    findAll(clause, PROTECTED_CHARACTER_SOURCE),
  );
  const allMarkNouns = findAll(clause, MARK_NOUN_SOURCE);
  const allProtectionTokens = findAll(clause, PROTECTION_TOKEN_SOURCE);

  const organizations = allOrganizations.filter((span) => survives(span, scopes));
  const characters = allCharacters.filter((span) => survives(span, scopes));
  const markNouns = allMarkNouns.filter((span) => survives(span, scopes));
  const protectionTokens = allProtectionTokens.filter((span) => survives(span, scopes));
  const reproductionVerbs = findAll(clause, REPRODUCTION_VERB_SOURCE).filter((span) =>
    survives(span, scopes),
  );
  const imitationCues = findAll(clause, IMITATION_CUE_SOURCE).filter((span) =>
    survives(span, scopes),
  );

  const ownsIt = OWNERSHIP_CLAIM.test(clause);
  const recognized = organizations.length > 0 || characters.length > 0;
  // Ownership is a rescue only for an UNRECOGNIZED name. iHeartPrints does
  // not verify the claim and never implies it has; honouring it is a
  // usability decision, not a finding of ownership.
  const ownershipRescue = ownsIt && !recognized;

  /* ---- Evasion, checked first ------------------------------------------
   *
   * Evasion vocabulary is its own answer regardless of whether a mark is
   * named, and several evasion phrasings ("without making it obvious",
   * "remove the trademark symbol") embed an operator word themselves — see
   * `survivesAsEvasion` for why the scoping rule is strict here.
   */
  const evasionSpan =
    firstMatch(clause, SELF_SUFFICIENT_EVASION_PATTERNS) ??
    (SELF_REFERENCE.test(clause)
      ? null
      : firstMatch(clause, [NEAR_IDENTICAL_EVASION])) ??
    (subjectHasReferent ? firstMatch(clause, REFERENT_BOUND_EVASION_PATTERNS) : null);

  if (evasionSpan && survivesAsEvasion(evasionSpan, scopes)) {
    findings.push({
      reason: "protection_evasion_request",
      evidence: evidenceOf(clause),
    });
  }

  /* ---- Reproduction / imitation ---------------------------------------- */

  const push = (reason: IpSafetyReason) =>
    findings.push({ reason, evidence: evidenceOf(clause) });

  // A surviving protected character is reproduced by being depicted at all.
  if (characters.length > 0) {
    push("protected_character_reproduction");
    return findings;
  }

  // A surviving recognized organization alongside a surviving brand
  // identifier.
  //
  // DELIBERATE GAP: a bare possessive over an unrecognized name — "recreate
  // Rivera Plumbing's logo" — is NOT treated as a third-party mark. It is
  // structurally identical to the most common legitimate business request,
  // and refusing it would make the product unusable for them (Goal 6).
  if (markNouns.length > 0 && organizations.length > 0) {
    push("third_party_mark_reproduction");
    return findings;
  }

  // "Recreate the trademarked emblem" — an explicit protection statement
  // over an unnamed mark. Rescued by an ownership claim, because a business
  // customer saying "make our trademarked logo bigger" is describing their
  // own registered branding, not someone else's.
  if (markNouns.length > 0 && protectionTokens.length > 0 && !ownershipRescue) {
    push("third_party_mark_reproduction");
    return findings;
  }

  // "Make it recognizably Raiders", "same as their logo" — recognizable
  // sameness, with or without the word "logo". Rescued by an ownership claim
  // over an unrecognized name, because "make my logo exactly the same but
  // bigger" is an ordinary request.
  if (
    imitationCues.length > 0 &&
    (markNouns.length > 0 || organizations.length > 0) &&
    !ownershipRescue
  ) {
    push("recognizable_mark_imitation");
    return findings;
  }

  // An outright reproduction verb aimed at a recognized organization, with
  // no brand identifier named ("copy the Lakers", "replicate Nike").
  if (reproductionVerbs.length > 0 && organizations.length > 0) {
    push("third_party_mark_reproduction");
  }

  return findings;
}

/** Stable ordering for internal reason lists — never customer-facing. */
export const IP_SAFETY_REASON_ORDER: readonly IpSafetyReason[] = [
  "protection_evasion_request",
  "third_party_mark_reproduction",
  "protected_character_reproduction",
  "recognizable_mark_imitation",
];
