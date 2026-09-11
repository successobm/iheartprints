/**
 * Universal Raster Reconstruction Phase R4A: the shared, provider-neutral
 * shape of a machine-PROPOSED fidelity fact — never authority. See
 * `ArtworkFidelityCapability`'s own doc comment for the authority rule this
 * whole capability exists underneath: VISION PROPOSES, CUSTOMER/OPERATOR
 * CONFIRMS, never the reverse.
 *
 * Directly informed by the Phase R3C/R3D research findings (see
 * `research/raster-reconstruction-r3c/` on the `research/r3c-fidelity-fact-
 * extraction` branch, not merged into this codebase — this module
 * reimplements the PROVEN prompt/schema shape in production transport code,
 * never imports the research `.mjs` scripts):
 *
 *   - primary wording extraction is reliable; secondary/small wording under
 *     real degradation is not, and must never be silently trusted;
 *   - explicit permission (and instruction) to answer `partially_readable`/
 *     `cannot_read` instead of guessing materially reduces confident
 *     hallucination (R3D Hypothesis A — confirmed);
 *   - forcing the provider to describe a protected mark's visible GEOMETRY
 *     before classifying it (rather than classifying from brand
 *     convention/assumption) measurably improves — but does not eliminate —
 *     ® vs ™ confusion (R3D Hypothesis B — partially confirmed); the
 *     customer confirmation step this phase builds is exactly how the
 *     product compensates for the part prompting alone could not fix.
 *
 * `schemaVersion` is stamped into every persisted `proposedFacts` payload so
 * a future change to this shape never has to guess which prompt/schema
 * produced an old, already-persisted proposal.
 *
 * Phase R4A-R (independent-review repair, Blockers 2/3): two additions to
 * the shape below, both REQUIRED to make server-side confirmation
 * completeness possible at all — see `artwork-fidelity-service.ts`'s own
 * doc comment for how they're used:
 *
 *   - every wording/mark entry now carries a stable `id`, assigned ONCE by
 *     `ArtworkFidelityProposalCapability` when a proposal is built (never by
 *     the provider itself, which has no concept of proposal identity, and
 *     never by the client). The id is proposal-local (unique within THIS
 *     proposal only, not globally) and immutable for the life of the
 *     proposal — a correction always proposes an entirely new row (existing
 *     R3B precedent), which mints entirely new ids, never reuses old ones.
 *     Confirmation submits RESOLUTIONS keyed by these ids so the server can
 *     verify every proposed region was explicitly addressed, rather than
 *     trusting array position/order (which a malformed client could reorder
 *     or omit from without detection).
 *   - `proposalStatus: "analyzed" | "unavailable"` distinguishes a GENUINE
 *     successful provider analysis that happened to find zero facts from a
 *     provider that never actually ran (misconfigured, placeholder, or
 *     failed) — see `ArtworkFidelityProposalResult.analyzed`. An empty
 *     `wording`/`protectedMarks` array means something different depending
 *     on this field, and the confirmation UI/server treat the two
 *     differently (Section 6/7 of the R4A-R task).
 */

export const ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION = "artwork-fidelity-proposal:v2";

export const WORDING_READABILITY_VALUES = [
  "readable",
  "partially_readable",
  "cannot_read",
] as const;
export type WordingReadability = (typeof WORDING_READABILITY_VALUES)[number];

export const PROPOSAL_CONFIDENCE_VALUES = ["high", "medium", "low"] as const;
export type ProposalConfidence = (typeof PROPOSAL_CONFIDENCE_VALUES)[number];

/** Mirrors `ProtectedMarkType`'s closed set plus the two answers with no confirmed-authority equivalent — a proposal may honestly say "I cannot tell" in a way confirmed authority never may. */
export const MARK_CLASSIFICATION_VALUES = ["TM", "R", "C", "cannot_determine"] as const;
export type MarkClassificationProposal = (typeof MARK_CLASSIFICATION_VALUES)[number];

/**
 * Phase R4A-R: whether a REAL provider analysis actually ran and produced
 * this result. `false` for the safe placeholder (misconfigured/absent
 * credentials, or unconditionally forced under
 * `isAutomatedTestEnvironment()`) and for any caught provider failure
 * (network, rate limit, malformed response, timeout, auth) — `true` ONLY
 * for a genuine, successful provider response, even one that legitimately
 * found zero wording/marks. This is the raw, provider-level signal;
 * `ArtworkFidelityProposedFacts.proposalStatus` is the persisted,
 * capability-level projection of it.
 */
export type ProposalAnalysisStatus = "analyzed" | "unavailable";

/** Raw provider-level entry — no `id` yet (the provider has no concept of proposal identity; ids are assigned once, capability-side, when a proposal is actually built). */
export interface RawWordingFactProposal {
  /** Best-effort transcription using ONLY visibly-supported characters, or `null` when `readability` is `"cannot_read"`. Never a guessed/completed word. */
  text: string | null;
  readability: WordingReadability;
  confidence: ProposalConfidence;
  /** A short, concise description of visible evidence only — e.g. "bold capital letters, clear separation". NEVER hidden chain-of-thought or step-by-step private reasoning. */
  visibleEvidence: string;
}

export interface RawProtectedMarkFactProposal {
  /** What is actually visually observed, described BEFORE classification — e.g. "letter R enclosed by a circle". Observation only, never hidden reasoning. */
  visualDescription: string;
  classification: MarkClassificationProposal;
  confidence: ProposalConfidence;
}

/**
 * Persisted/domain shape — a `RawWordingFactProposal` plus the stable,
 * proposal-local `id` the capability assigns. This is what
 * `ArtworkFidelityProposedFacts.wording` actually stores, and what the
 * confirmation UI/route/service key resolutions against.
 */
export interface WordingFactProposal extends RawWordingFactProposal {
  id: string;
}

export interface ProtectedMarkFactProposal extends RawProtectedMarkFactProposal {
  id: string;
}

export interface ArtworkFidelityProposalResult {
  wording: RawWordingFactProposal[];
  protectedMarks: RawProtectedMarkFactProposal[];
  /** The provider's own request/response id, for support diagnosis only — never customer-facing, never logged with any image byte or credential. */
  providerRequestId: string | null;
  /** See `ProposalAnalysisStatus`'s own doc comment. */
  analyzed: boolean;
}

/**
 * The exact shape persisted into `ArtworkFidelityContract.proposedFacts`
 * (`Record<string, unknown>`) — deliberately generic-typed at the domain
 * layer (Section 3 of this phase's own task: "do not create new durable
 * authority fields unless clearly required by existing schema"), but always
 * written in THIS shape by this capability. `sanitizedProvider` carries only
 * non-sensitive, support-diagnostic metadata — never a raw request/response
 * body, never a credential, never a signed URL.
 */
export interface ArtworkFidelityProposedFacts {
  schemaVersion: typeof ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION;
  proposalStatus: ProposalAnalysisStatus;
  wording: WordingFactProposal[];
  protectedMarks: ProtectedMarkFactProposal[];
  sanitizedProvider: {
    providerKey: string;
    proposedAt: string;
  };
}

export function isArtworkFidelityProposedFacts(
  value: unknown,
): value is ArtworkFidelityProposedFacts {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION) return false;
  if (candidate.proposalStatus !== "analyzed" && candidate.proposalStatus !== "unavailable") {
    return false;
  }
  return Array.isArray(candidate.wording) && Array.isArray(candidate.protectedMarks);
}

/**
 * The persistence-layer's own `proposedFacts` column type
 * (`Record<string, unknown> | null`) is deliberately generic (Section 3 —
 * "do not create new durable authority fields unless clearly required by
 * existing schema"), so it has no index signature matching this module's
 * strictly-typed `ArtworkFidelityProposedFacts`. This is the one, explicit,
 * narrow widening point — never used to smuggle an arbitrary shape past a
 * caller that actually cares what's inside (every real reader goes through
 * `isArtworkFidelityProposedFacts` first).
 */
export function toProposedFactsRecord(
  facts: ArtworkFidelityProposedFacts,
): Record<string, unknown> {
  return facts as unknown as Record<string, unknown>;
}
