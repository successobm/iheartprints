/**
 * Universal Raster Reconstruction Phase R4A-R (independent-review repair,
 * Blockers 2/7/8/9): pure, server-side confirmation completeness
 * validation — the piece the original R4A implementation was missing
 * entirely. UI-disabled-button behavior is not a security invariant; this
 * module is what makes "the server must reject incomplete/invalid
 * confirmation even if the UI normally prevents it" actually true.
 *
 * Deliberately pure and I/O-free (no repository, no capability graph) so it
 * is trivially unit-testable in isolation — `artwork-fidelity-service.ts`
 * is the only caller, and it supplies the STORED proposal (never a
 * client-supplied copy of it) plus whatever resolutions the request body
 * carried.
 *
 * IDENTITY, NOT POSITION: every proposed wording/mark entry carries a
 * stable `id` (`ArtworkFidelityProposalCapability`'s own doc comment) —
 * resolutions are matched against the STORED proposal by that id, never by
 * array order/position, so a malformed or adversarial client cannot bypass
 * completeness by omitting, reordering, or duplicating entries.
 *
 * THE CUSTOMER MAY DISAGREE WITH THE PROPOSAL — that is the entire point of
 * a confirmation step. A resolution's text is never required to match the
 * proposal's own `text` field; the only requirement is that EVERY proposed
 * region received exactly one, well-formed, explicit resolution.
 */

import type {
  ArtworkFidelityProposedFacts,
  WordingFactProposal,
} from "@/capabilities/artwork-fidelity-proposal";
import type { ProtectedMarkType } from "@/lib/domain/types";
import { PROTECTED_MARK_TYPES } from "@/lib/domain/types";

export class ArtworkFidelityConfirmationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtworkFidelityConfirmationValidationError";
  }
}

/**
 * One region's explicit resolution. Exactly one of `text`/`excluded` must
 * be present — never both, never neither (Section 3: "reject... missing
 * resolution... malformed item").
 */
export interface WordingResolutionInput {
  id: string;
  /** The customer's own authoritative text for this region — need not match the proposal's own guess at all. */
  text?: string;
  /** "This text isn't actually in my artwork" — the explicit-exclusion resolution. */
  excluded?: boolean;
}

/**
 * `"NONE"` is the explicit "this region is not actually a protected mark"
 * resolution — distinct from an omitted/missing resolution, which is
 * rejected outright. `"NOT_SURE"` is deliberately NOT a member of this
 * type — it can never be submitted as a valid resolution at all (enforced
 * at the route's zod boundary AND re-checked here, defense in depth).
 */
export interface MarkResolutionInput {
  id: string;
  mark: ProtectedMarkType | "NONE";
}

export interface ConfirmationResolutionsInput {
  wordingResolutions: WordingResolutionInput[];
  markResolutions: MarkResolutionInput[];
}

export interface DerivedConfirmation {
  confirmedWording: string[];
  confirmedMarks: ProtectedMarkType[];
}

const VALID_MARK_TOKENS = new Set<string>([...PROTECTED_MARK_TYPES, "NONE"]);

function fail(message: string): never {
  throw new ArtworkFidelityConfirmationValidationError(message);
}

/**
 * Matches resolutions to proposed regions by `id` — every proposed id must
 * have EXACTLY ONE resolution; no resolution may reference an id the
 * stored proposal does not have (an "invented" region); no id may be
 * resolved twice.
 */
function indexResolutionsById<R extends { id: string }>(
  proposedIds: readonly string[],
  resolutions: readonly R[],
  kind: "wording" | "mark",
): Map<string, R> {
  const byId = new Map<string, R>();
  for (const resolution of resolutions) {
    if (!resolution || typeof resolution.id !== "string" || resolution.id.length === 0) {
      fail(`A ${kind} resolution is missing a valid proposal item id.`);
    }
    if (byId.has(resolution.id)) {
      fail(`Duplicate resolution submitted for ${kind} region "${resolution.id}".`);
    }
    if (!proposedIds.includes(resolution.id)) {
      fail(`Resolution submitted for an unknown ${kind} region "${resolution.id}".`);
    }
    byId.set(resolution.id, resolution);
  }
  for (const proposedId of proposedIds) {
    if (!byId.has(proposedId)) {
      fail(`Missing required resolution for ${kind} region "${proposedId}".`);
    }
  }
  return byId;
}

function resolveWording(
  proposed: readonly WordingFactProposal[],
  resolutions: readonly WordingResolutionInput[],
): string[] {
  const proposedIds = proposed.map((entry) => entry.id);
  const byId = indexResolutionsById(proposedIds, resolutions, "wording");

  const confirmed: string[] = [];
  for (const entry of proposed) {
    const resolution = byId.get(entry.id)!;
    const hasText = typeof resolution.text === "string";
    const hasExclusion = resolution.excluded === true;
    if (hasText === hasExclusion) {
      // Both present, or neither present -- an unresolved/ambiguous region
      // is never silently treated as "excluded" nor as "blank text".
      fail(
        `Wording region "${entry.id}" must be resolved with EITHER authoritative text OR an explicit exclusion, not both or neither.`,
      );
    }
    if (hasExclusion) continue;
    const text = (resolution.text as string).trim();
    if (text.length === 0) {
      fail(`Wording region "${entry.id}" was submitted with blank/whitespace-only text.`);
    }
    // Exact customer capitalization/punctuation preserved verbatim from
    // here on -- only leading/trailing whitespace is trimmed, never case-
    // folded, never otherwise normalized.
    confirmed.push(text);
  }
  return confirmed;
}

function resolveMarks(
  proposed: readonly { id: string }[],
  resolutions: readonly MarkResolutionInput[],
): ProtectedMarkType[] {
  const proposedIds = proposed.map((entry) => entry.id);
  const byId = indexResolutionsById(proposedIds, resolutions, "mark");

  const confirmed = new Set<ProtectedMarkType>();
  for (const entry of proposed) {
    const resolution = byId.get(entry.id)!;
    if (typeof resolution.mark !== "string" || !VALID_MARK_TOKENS.has(resolution.mark)) {
      // Catches a literal "NOT_SURE" (or anything else invalid) that somehow
      // reached this function directly, bypassing the route's own zod enum
      // -- defense in depth, never trusting a single validation layer.
      fail(`Mark region "${entry.id}" was resolved with an invalid token.`);
    }
    if (resolution.mark === "NONE") continue;
    confirmed.add(resolution.mark);
  }
  return [...confirmed];
}

/**
 * The ONE function `artwork-fidelity-service.ts` calls before ever handing
 * anything to `ArtworkFidelityCapability.confirmContract`. Throws
 * `ArtworkFidelityConfirmationValidationError` (never returns a partial/
 * best-effort result) for ANY of: a missing resolution, an unknown/invented
 * region id, a duplicate resolution, blank/whitespace-only text, an
 * ambiguous wording item (both or neither of text/excluded), or an invalid
 * mark token (including "NOT_SURE"). The caller must not proceed to
 * `confirmContract` on a thrown error — no partial mutation occurs because
 * this function runs entirely before any write.
 */
export function validateAndDeriveConfirmation(
  facts: ArtworkFidelityProposedFacts,
  input: ConfirmationResolutionsInput,
): DerivedConfirmation {
  return {
    confirmedWording: resolveWording(facts.wording, input.wordingResolutions ?? []),
    confirmedMarks: resolveMarks(facts.protectedMarks, input.markResolutions ?? []),
  };
}
