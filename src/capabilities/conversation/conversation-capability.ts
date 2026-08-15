import type { ProjectRepository } from "@/lib/db/repository";
import { toDesignBriefSnapshotContent } from "@/lib/domain/brief-snapshot";
import {
  isLegacyScriptedPhase,
  nextPhaseAfterUserReply,
  promptForPhase,
} from "@/lib/domain/conversation";
import type {
  ConversationPhase,
  InterviewStateData,
  ProjectSnapshot,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import {
  createAcquisitionCapability,
  type AcquisitionCapability,
} from "@/capabilities/acquisition";
import type { BriefEvaluationCapability } from "@/capabilities/brief-evaluation";
import type { ConceptGenerationCapability } from "@/capabilities/concept-generation";
import type { ConversationUnderstandingCapability } from "@/capabilities/conversation-understanding";
import type { DesignBriefCapability } from "@/capabilities/design-brief";
import type { DesignIntelligenceCapability } from "@/capabilities/design-intelligence";
import type { DesignSummaryCapability } from "@/capabilities/design-summary";
import type { FinalArtworkCapability } from "@/capabilities/final-artwork";
import type { IntentExtractionCapability } from "@/capabilities/intent-extraction";
import type { InterviewIntelligenceCapability } from "@/capabilities/interview-intelligence";
import type { IpSafetyCapability, IpSafetySignal } from "@/capabilities/ip-safety";
import { describeIpSafetyDecisionForCustomer } from "@/capabilities/ip-safety";
import type { RevisionIntelligenceCapability } from "@/capabilities/revision-intelligence";
import {
  CHAT_BLOCKED_PHASES as SHARED_CHAT_BLOCKED_PHASES,
  REVISION_LOOP_PHASES as SHARED_REVISION_LOOP_PHASES,
} from "@/capabilities/shared/chat-input-policy";
import { ALL_SECTIONS_IN_POLICY_ORDER } from "@/capabilities/shared/interview-coverage-policy";
import { diffEstablishedBriefSections } from "@/capabilities/shared/brief-diff";
import { resolveProductionWidth } from "@/capabilities/shared/print-placement-dimensions";
import { describePrintReadySize } from "@/capabilities/shared/print-ready-size";
import {
  detectProductionSizeIntent,
  RELATIVE_SIZE_STEP_IN,
} from "@/capabilities/shared/production-size-intent";
import {
  acknowledgeRequestedChanges,
  acknowledgeResolvedFields,
  acknowledgeRevision,
  conceptRegenerationPrompt,
  describeUndo,
  designerDecisionMessage,
  productionSizeAcknowledgement,
  revisionGeneratingMessage,
  shortAcknowledgement,
} from "@/capabilities/shared/question-phrasing";
import { productNameForQuestion } from "@/capabilities/shared/print-product-vocabulary";
import { splitRequestedChanges } from "@/capabilities/shared/revision-delta";
import { isExplicitRevisionIntent } from "@/capabilities/shared/revision-intent";
import { traceConversationUnderstanding } from "@/lib/debug/conversation-understanding-trace";
import type {
  BriefSectionKey,
  DesignSummaryView,
  IntelligenceAssessment,
  InterviewAct,
  RevisionImpact,
} from "@/capabilities/shared/contracts";

/** Sprint 2L Phase 1B (Goal 12): "continue" removed — see schema.ts. */
export type DesignBriefDecisionAction = "approve" | "edit";

export interface ConversationCapabilityDeps {
  repo: ProjectRepository;
  intentExtraction: IntentExtractionCapability;
  /**
   * Sprint 2L Phase 1: best-effort semantic interpretation of the customer's
   * message, consumed by `intentExtraction.extract` as an optional hint —
   * see `reconcile-understanding.ts` for precedence. Never mutates the
   * brief itself.
   */
  conversationUnderstanding: ConversationUnderstandingCapability;
  designBrief: DesignBriefCapability;
  briefEvaluation: BriefEvaluationCapability;
  designIntelligence: DesignIntelligenceCapability;
  interviewIntelligence: InterviewIntelligenceCapability;
  revisionIntelligence: RevisionIntelligenceCapability;
  designSummary: DesignSummaryCapability;
  conceptGeneration: ConceptGenerationCapability;
  /** Sprint 2M Phase 2B: owns final-direction approval persistence + idempotent finalization request. */
  finalArtwork: FinalArtworkCapability;
  /**
   * Sprint A3: the IP / trademark safety boundary. Consulted on every
   * customer turn that could become new design content, BEFORE any brief
   * mutation and long before any paid generation. Pure and synchronous.
   */
  ipSafety: IpSafetyCapability;
  /**
   * Sprint A4: the acquisition entitlement boundary. Consulted here only
   * for the email-to-continue gate — the generation and finalization
   * fences live in `ConceptGenerationCapability` and
   * `FinalArtworkCapability`, where the durable job that authorizes spend
   * is actually created.
   *
   * Optional so existing composition/test call sites that predate A4 keep
   * working; a missing dependency resolves to a fresh instance over the
   * same repository, which is the correct direction for a gate to default.
   */
  acquisition?: AcquisitionCapability;
}

/**
 * Phases where free-text chat input is not the expected interaction.
 * Shared with the composer's own enabled/disabled rule so the two can
 * never disagree — see `chat-input-policy.ts`.
 */
const CHAT_BLOCKED_PHASES = SHARED_CHAT_BLOCKED_PHASES;

/** Phases reachable only after at least one approved brief version exists. */
const POST_APPROVAL_PHASES: ConversationPhase[] = [
  "brief_approved",
  "generating",
  "concepts_ready",
  "ask_revisions",
  "revision_received",
];

/** Post-concept revision loop — customer describing changes to an already-approved brief. */
const REVISION_REQUEST_PHASES = SHARED_REVISION_LOOP_PHASES;

const KNOWN_SECTIONS = new Set<string>(ALL_SECTIONS_IN_POLICY_ORDER);

/**
 * Sprint 2G Part 3: deterministic natural-language triggers. None of these
 * gate interpretation of the *next* reply the way Sprint 2G Part 2's
 * `awaitingConceptRegenerationConfirmation` did — every reply is always
 * just itself. "If the customer ignores it, continue normally."
 */
const UNDO_PATTERN =
  /^(?:undo|revert)\b|undo (?:that|it|the last (?:change|revision|edit)|shirt color|wording|graphics|colors?|style|placement)|go back to (?:the )?previous(?: version)?/i;
const REGENERATE_REQUEST_PATTERN =
  /\b(regenerate|update the concepts|new concepts|updated concepts|refresh the concepts|generate updated concepts)\b/i;
const KEEP_CONCEPTS_PATTERN =
  /\bkeep (?:the )?(?:current|existing) concepts\b|\bleave (?:them|the concepts)(?: as (?:is|they are))?\b/i;

/**
 * Live Acceptance Corrective Pass (Section 3): a customer explicitly asking
 * to see other creative directions — never a customer describing a change
 * to make to the concept they already selected. Checked unconditionally
 * (not gated by concept staleness) and takes priority over the default
 * single-concept-revision path: "give me three different versions" must
 * always explore, never just tweak the one already selected.
 */
const ALTERNATIVES_REQUEST_PATTERN =
  /\b(?:show me (?:a few|some|three)?\s*(?:different\s+)?(?:versions|alternatives|options|directions)|(?:a )?few (?:other|different) (?:directions|versions|options)|three different (?:versions|directions|concepts)|other directions|different directions|other options|alternative directions|start over with new concepts|new set of concepts)\b/i;

/**
 * Live Acceptance Corrective Pass (Section 2): the customer's explicit "no
 * more changes" confirmation, typed rather than clicked. Deliberately a
 * short, closed list of unambiguous whole-message phrases (matched against
 * the ENTIRE trimmed reply) rather than a loose keyword — a customer
 * casually saying "looks good" mid-conversation must never be silently
 * read as final approval (Constitution §15: print-ready is earned, not
 * assumed). The `[Use This Design]` button drives the same confirmation
 * through `ConversationCapability.confirmSelectedDirection` without relying
 * on this pattern at all.
 */
const CONFIRM_FINAL_PATTERN =
  /^(?:no changes(?: needed)?|use this (?:design|one|concept)|this is the one|i'?m happy with (?:it|this)|keep it as(?: it)? is|that'?s it,? use this one)[.!]?$/i;

/**
 * Owns conversation lifecycle, messages, state, and orchestration.
 * Must NOT own brief mutation logic, generation internals, or product rules.
 *
 * Sprint 2D: the interview no longer generates concepts on its own — it
 * hands off to a Design Summary confirmation gate; only an explicit
 * customer Approve decision may trigger concept generation.
 *
 * Sprint 2F: pre-approval turns run through an adaptive pipeline
 * (Intent Extraction → Design Brief → Brief Evaluation → Design
 * Intelligence → Interview Intelligence → best next act) instead of a
 * fixed phase ladder. The old ladder is preserved verbatim for historical
 * projects still mid-flow in an `ask_*` phase.
 *
 * Sprint 2G Part 2: the post-concept revision loop is adaptive too —
 * Revision Intelligence scopes what actually needs re-evaluating and
 * whether existing concepts are now stale.
 *
 * Sprint 2G Part 3: that intelligence becomes visible and actionable —
 * updated-field transitions and deferred decisions ride along with the
 * Design Summary; a "Designer Decision" note accompanies any explicit
 * deferral; concept staleness is a persistent, non-interrupting action
 * (`regenerateConcepts`) rather than a one-shot yes/no gate; and one level
 * of undo (`undoLastChange`) is available for the most recently accepted
 * revision.
 */
export interface ConversationCapability {
  /**
   * Sprint A4: `acquisitionSessionId` binds the new project to the session
   * that created it — the durable authority every paid-value gate later
   * resolves from. Omitted/`null` produces a legacy-unbound project, which
   * is what internal callers and capability tests get.
   */
  start(acquisitionSessionId?: string | null): Promise<ProjectSnapshot>;
  get(designId: string): Promise<ProjectSnapshot | null>;
  handleUserMessage(
    designId: string,
    content: string,
  ): Promise<ProjectSnapshot>;
  selectConcept(
    designId: string,
    artworkVersionId: string,
  ): Promise<ProjectSnapshot>;
  /**
   * Live Acceptance Cleanup (Issue 2): the explicit inverse of
   * `selectConcept` — "Change Selection". Returns the project to "none
   * selected" so the customer can compare the concepts again, or recover
   * from a misclick, without Start Over.
   *
   * Semantics, all server-owned (never a client-only visual reset):
   *   - `PrintProject.selectedArtworkVersionId` → `null`, every
   *     `ArtworkVersion.isSelected` → `false`
   *   - `finalDirectionConfirmed` → `false` (a confirmation can never
   *     outlive the selection it was about), so revision and finalization
   *     actions become unavailable, enforced server-side by
   *     `FinalArtworkCapability` as well as by the UI
   *   - any active `FinalDirectionApproval` is explicitly SUPERSEDED, never
   *     silently orphaned
   *   - nothing is deleted: every concept, batch, revision, and history
   *     entry survives untouched and stays selectable
   *   - no generation is triggered
   *
   * Refuses (rather than resolving quietly) while a revision is mid-flight
   * or a finalization is running/complete — those own the selection right
   * now, and invalidating them behind the customer's back is exactly the
   * "silently invalidate a production approval" failure this must avoid.
   */
  unselectConcept(designId: string): Promise<ProjectSnapshot>;
  /**
   * Live Acceptance Cleanup (Issue 3): "Show Me 3 New Concepts" — the
   * middle option between selecting one of the current three and Start
   * Over. Keeps the approved Design Brief exactly as it is and explores a
   * fresh batch of three directions from it. See
   * `ConceptGenerationCapability.exploreNewConceptBatch`.
   */
  exploreNewConceptBatch(designId: string): Promise<ProjectSnapshot>;
  /**
   * Live Acceptance Cleanup (Issue 5): records the customer's chosen
   * PRODUCTION print width, in inches — a production-specification change,
   * never a creative revision. It produces no `ArtworkVersion`, calls no
   * image provider, approves no brief version, and leaves the approved
   * artwork exactly as it is. `null` returns the project to the placement
   * default.
   */
  setProductionPrintWidth(
    designId: string,
    requestedWidthIn: number | null,
  ): Promise<ProjectSnapshot>;
  /**
   * Sprint 2M Phase 2B: the customer's explicit "this is my final direction
   * — prepare it for production" action. Distinct from `selectConcept` —
   * selecting only means "I want to work with this direction" and may
   * still be revised; this is the sole action that may authorize a
   * `FinalArtworkJob`. Idempotent — see `FinalArtworkCapability`.
   */
  approveFinalDirection(
    designId: string,
    artworkVersionId: string,
  ): Promise<ProjectSnapshot>;
  /** Approve / Edit / Continue in response to a presented Design Summary. */
  submitDesignBriefDecision(
    designId: string,
    action: DesignBriefDecisionAction,
  ): Promise<ProjectSnapshot>;
  /**
   * Completes a generation request that a previous turn left half-applied
   * — the durable authority to generate exists (an approved brief version,
   * or a pending revision) but the `GenerationJob` it was supposed to
   * create does not. Returns the project unchanged in every other
   * situation, and `null` if it does not exist.
   */
  recoverInterruptedGenerationRequest(
    designId: string,
  ): Promise<ProjectSnapshot | null>;
  /** Explicit action behind the persistent "Generate Updated Concepts" control. */
  regenerateConcepts(designId: string): Promise<ProjectSnapshot>;
  /**
   * Live Acceptance Corrective Pass (Section 2): the customer's explicit
   * "no more changes, use this design" confirmation — the [Use This
   * Design] action. The sole way `PrintProject.finalDirectionConfirmed`
   * becomes `true`; `FinalArtworkCapability.requestFinalArtwork` refuses to
   * finalize without it, independent of `revisionPending`.
   */
  confirmSelectedDirection(
    designId: string,
    artworkVersionId: string,
  ): Promise<ProjectSnapshot>;
  /** Explicit action behind an "Undo" control — undoes the most recent accepted revision, if any. */
  undoLastChange(designId: string): Promise<ProjectSnapshot>;
}

export function createConversationCapability(
  deps: ConversationCapabilityDeps,
): ConversationCapability {
  const {
    repo,
    intentExtraction,
    conversationUnderstanding,
    designBrief,
    briefEvaluation,
    designIntelligence,
    interviewIntelligence,
    revisionIntelligence,
    designSummary,
    conceptGeneration,
    finalArtwork,
    ipSafety,
  } = deps;
  const acquisition = deps.acquisition ?? createAcquisitionCapability(repo);

  /**
   * Sprint A3 — THE CONVERSATIONAL GATE.
   *
   * Runs after the turn has been semantically interpreted (so the optional
   * `ipSignal` from the already-required Conversation Understanding call is
   * available at no extra cost) and BEFORE Intent Extraction's proposals are
   * applied. Placement is the whole point: a blocked request never reaches
   * the Design Brief, so it never becomes design content, never marks
   * concepts stale, never triggers an automatic revision, and never reaches
   * a generation fence at all.
   *
   * Correction 3: the whole conversation record is handed to the capability,
   * which bounds and filters it itself (`safety-subject.ts`) — a request
   * split across turns ("I want a Raiders design." → "Use their exact
   * shield.") is one request and has to be seen as one. Turns that were
   * themselves refused are excluded, so a customer is never punished for
   * rephrasing.
   *
   * NOTHING DURABLE CHANGES on a block. No brief write, no phase change, no
   * interview-state change, no status change — only an assistant message
   * redirecting toward an original design. That is what makes "a project is
   * never permanently poisoned by one blocked request" structural: the very
   * next message is evaluated against an unchanged project, and the refused
   * turn is not carried forward as context.
   *
   * Returns the refreshed snapshot when the turn was blocked, or `null` to
   * carry on with the normal pipeline.
   */
  async function guardCustomerRequest(
    designId: string,
    current: ProjectSnapshot,
    message: string,
    semanticSignal: IpSafetySignal | null | undefined,
  ): Promise<ProjectSnapshot | null> {
    const decision = ipSafety.evaluateCustomerRequest({
      message,
      messages: current.messages,
      semanticSignal: semanticSignal ?? null,
    });
    const customerMessage = describeIpSafetyDecisionForCustomer(decision);
    if (!customerMessage) return null;

    // Metadata stays deliberately generic. `ProjectSnapshot.messages`
    // (metadata included) is client-visible, so a truthful-looking
    // `act: "ip_safety_block"` or a reason code here would be exactly the
    // internal-enum leak the boundary is required not to have.
    await repo.addMessage(designId, {
      role: "assistant",
      content: customerMessage,
      metadata: { phase: current.conversation.phase, act: "acknowledge" },
    });

    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  /**
   * Sprint 2L Phase 1: builds the bounded, provider-neutral interpretation
   * of `reply` in context — never the raw brief, ids, or full history (see
   * `ConversationUnderstandingCapability`'s own bounding/sanitization).
   * Never throws (the capability itself degrades to
   * `EMPTY_UNDERSTANDING_RESULT` on any provider failure — Goal 10).
   */
  async function interpretReply(
    snapshot: ProjectSnapshot,
    brief: TShirtDesignBrief,
    pendingSection: BriefSectionKey | null,
    reply: string,
  ) {
    const evaluation = briefEvaluation.evaluate(brief);
    const knownBrief = designSummary.createSummary(brief, evaluation);
    const unresolvedSections = evaluation.sections
      .filter((s) => s.resolution === "unknown")
      .map((s) => s.section);
    return conversationUnderstanding.interpret({
      message: reply,
      knownBrief,
      unresolvedSections,
      pendingSection,
      recentMessages: snapshot.messages,
    });
  }

  /**
   * Takes the (already-fetched, post-mutation) brief and interview state
   * directly rather than re-reading them — every caller already has both
   * in hand by the time it's ready to summarize, and each avoided read
   * matters here: a full adaptive interview does many more small
   * read-modify-write turns than the old four-question ladder did.
   *
   * `updatedSections` and `previousBrief`, when given, produce
   * `fieldTransitions` (old → new values, Sprint 2G Part 3) attached to
   * the message metadata so the UI can highlight what changed without any
   * internal detail beyond the section keys and their own displayed
   * values. `deferredDecisions` always accompanies the summary as its own
   * section — never blank, never phrased as missing.
   */
  async function presentDesignSummary(
    designId: string,
    brief: TShirtDesignBrief,
    interviewState: InterviewStateData | null,
    options: {
      previousBrief?: TShirtDesignBrief;
      updatedSections?: BriefSectionKey[];
    } = {},
  ): Promise<void> {
    const updatedSections = options.updatedSections ?? [];
    const evaluation = briefEvaluation.evaluate(brief);
    const summary = designSummary.createSummary(brief, evaluation);
    const deferredDecisions = designSummary.listDeferredDecisions(evaluation);
    const content = designSummary.formatForCustomer(summary, deferredDecisions);

    const fieldTransitions = options.previousBrief
      ? buildFieldTransitions(
          designSummary.createSummary(
            options.previousBrief,
            briefEvaluation.evaluate(options.previousBrief),
          ),
          summary,
          updatedSections,
        )
      : {};

    await repo.updateConversationPhase(designId, "awaiting_summary_confirmation");
    if (interviewState) {
      await repo.updateConversationInterviewState(designId, {
        ...interviewState,
        pendingSection: null,
      });
    }
    await repo.addMessage(designId, {
      role: "assistant",
      content,
      metadata: {
        phase: "awaiting_summary_confirmation",
        summary,
        deferredDecisions,
        updatedSections,
        fieldTransitions,
      },
    });
  }

  async function approveAndGenerate(designId: string): Promise<ProjectSnapshot> {
    const version = await designBrief.approveWorkingBrief(designId);

    // Approval is a checkpoint: undo is scoped to "the most recent
    // accepted revision" of the post-approval revision phase, not
    // leftover state from resolving the interview itself (e.g. a final
    // deferral just before summarizing).
    const beforeApproval = await repo.getProject(designId);
    if (beforeApproval?.conversation.interviewState.lastRevision) {
      await repo.updateConversationInterviewState(designId, {
        ...beforeApproval.conversation.interviewState,
        lastRevision: null,
      });
    }

    await repo.updateConversationPhase(designId, "brief_approved");
    await repo.setProjectStatus(designId, "approved");

    // Nothing here promises generation. The only "I'm creating three
    // concept directions" acknowledgement is the one `enqueue` writes
    // immediately after the durable `GenerationJob` exists — an
    // acknowledgement written before that is a promise the platform
    // cannot keep if the enqueue fails, and it survives the failed
    // request to be replayed on every later read.
    return conceptGeneration.generatePlaceholders(designId, version.id);
  }

  /**
   * Repairs the one state approval can fail into: the brief version is
   * durable and the customer was told nothing is left to decide, but the
   * `GenerationJob` that approval was supposed to create does not exist.
   * Nothing polls such a project (its status never reached "generating")
   * and the Design Summary's Approve control is no longer rendered, so
   * without this the customer's approval is silently lost.
   *
   * This is not system-initiated generation: the customer already gave
   * explicit approval, and this only carries out the request the platform
   * failed to complete. It is deliberately the narrowest possible repair —
   * it refuses unless the project has an approved brief, no concepts at
   * all, and *no generation job in any state*. That last condition is what
   * keeps a read path from re-queueing a job that already failed and gave
   * up, which would otherwise restart generation on every page load.
   */
  async function completeInterruptedApproval(
    designId: string,
    current: ProjectSnapshot,
  ): Promise<ProjectSnapshot> {
    if (!POST_APPROVAL_PHASES.includes(current.conversation.phase)) {
      return current;
    }
    if (current.artworkVersions.length > 0) return current;

    const approved = await designBrief.getLatestApprovedVersion(designId);
    if (!approved) return current;

    const jobs = await repo.listGenerationJobs(designId);
    if (jobs.length > 0) return current;

    return conceptGeneration.generatePlaceholders(designId, approved.id);
  }

  /**
   * The revision counterpart of `completeInterruptedApproval`, for the same
   * non-atomic window: `triggerAutomaticRevision` writes the durable
   * pending-revision authority (`PrintProject.revisionPending`) and
   * supersedes any active final-direction approval BEFORE the
   * regeneration `GenerationJob` exists, so a failure in between leaves a
   * project that is permanently barred from finalization
   * (`FinalArtworkCapability.requestFinalArtwork` refuses while
   * `revisionPending`) with nothing running to lift the bar. Nothing
   * clears that flag except a regeneration that actually completes and
   * produces artwork.
   *
   * The customer is not told to do anything about it — they were told the
   * concept is being updated — so the only escape today is noticing the
   * "Generate Updated Concepts" banner, which that very message implies is
   * unnecessary.
   *
   * Narrow by construction, and never a way to retry a job that already
   * exists: it refuses unless the pending revision has a source concept, a
   * newer approved brief version, no artwork for that version, and *no
   * generation job for that version in any state* — so a regeneration that
   * already failed and exhausted its budget is left exactly as it is.
   * `revisionPending` is never cleared here; only real revised artwork
   * clears it (`GenerationWorkerCapability`).
   */
  async function completeInterruptedRevision(
    designId: string,
    current: ProjectSnapshot,
  ): Promise<ProjectSnapshot> {
    if (!current.project.revisionPending) return current;

    const sourceArtworkVersionId = current.project.selectedArtworkVersionId;
    if (!sourceArtworkVersionId) return current;

    const approved = await designBrief.getLatestApprovedVersion(designId);
    if (!approved) return current;

    // Revised artwork already exists for this approval — the revision was
    // carried out; nothing to re-request.
    const alreadyRevised = current.artworkVersions.some(
      (artwork) => artwork.designBriefVersionId === approved.id,
    );
    if (alreadyRevised) return current;

    const jobs = await repo.listGenerationJobs(designId);
    const alreadyRequested = jobs.some(
      (job) => job.designBriefVersionId === approved.id,
    );
    if (alreadyRequested) return current;

    // True Source-Image Targeted Revision: recover the delta too, not just
    // the job. The instruction that triggered this revision is the most
    // recent customer message — it is durable, and without it the resumed
    // job would have a source image but nothing to change about it.
    const revisionInstruction = latestCustomerMessage(current);

    return conceptGeneration.reviseSelectedConcept(
      designId,
      approved.id,
      sourceArtworkVersionId,
      revisionInstruction,
    );
  }

  /**
   * Re-approves the working brief and explores three fresh directions.
   * "Initial exploration" semantics — used pre-selection, and for an
   * explicit "show me alternatives" request after selection (Live
   * Acceptance Corrective Pass, Section 3). NOT the default post-selection
   * revision operation — see `performSelectedConceptRevision`.
   */
  async function performRegeneration(
    designId: string,
    state: InterviewStateData,
  ): Promise<ProjectSnapshot> {
    const version = await designBrief.approveWorkingBrief(designId);
    await repo.updateConversationInterviewState(designId, {
      ...state,
      pendingSection: null,
    });
    return conceptGeneration.regenerateAfterRevision(designId, version.id);
  }

  /**
   * Live Acceptance Corrective Pass (Section 3): re-approves the working
   * brief and revises ONE customer-selected concept — the default
   * post-selection revision operation. Produces exactly one new concept,
   * tagged back to `sourceArtworkVersionId`, in that source's own creative
   * direction. Never three unrelated directions (Constitution §14: a
   * revision continues the same design relationship, it doesn't restart
   * it).
   */
  async function performSelectedConceptRevision(
    designId: string,
    state: InterviewStateData,
    sourceArtworkVersionId: string,
    /**
     * True Source-Image Targeted Revision: the customer's literal
     * instruction, carried onto the durable `GenerationJob` so the worker
     * can tell an image-edit provider what to actually change. The brief
     * records design state, never the change itself.
     */
    revisionInstruction: string | null,
  ): Promise<ProjectSnapshot> {
    const version = await designBrief.approveWorkingBrief(designId);
    await repo.updateConversationInterviewState(designId, {
      ...state,
      pendingSection: null,
    });
    return conceptGeneration.reviseSelectedConcept(
      designId,
      version.id,
      sourceArtworkVersionId,
      revisionInstruction,
    );
  }

  /**
   * Sprint 2M Phase 2G (Goal 3, 4, 6, 7): the customer's explicit revision
   * instruction is authority to regenerate automatically.
   *
   * Marks the durable pending-revision authority (`PrintProject.revisionPending`)
   * BEFORE enqueueing — a reload between this call and the worker finishing
   * still truthfully shows a revision in progress (Goal 3) — and immediately
   * supersedes any active `FinalDirectionApproval` (Goal 7): a still-running
   * finalization job for the artwork the customer just superseded must never
   * later win a race and write `print_ready`.
   * `FinalArtworkWorkerCapability.maybeTransitionProjectStatus` already
   * refuses to transition project status once its own approval is no longer
   * the active one, so superseding it here (rather than only on regeneration
   * completion, as before this sprint) is the entire fix — no worker change
   * needed.
   *
   * Idempotent (Goal 4/8): if a regeneration is already in flight for this
   * project (rapid duplicate submit, retried request), this never enqueues
   * a second one — it only acknowledges and returns current state.
   */
  async function triggerAutomaticRevision(
    designId: string,
    current: ProjectSnapshot,
    stateWithUndo: InterviewStateData,
    impact: RevisionImpact,
    summaryForAck: DesignSummaryView,
    deferredDecision: { section: BriefSectionKey; message: string } | null,
    /** The customer's literal revision instruction for this turn. */
    revisionInstruction: string,
  ): Promise<ProjectSnapshot> {
    await repo.updateConversationPhase(designId, "revision_received");
    await repo.updateConversationInterviewState(designId, {
      ...stateWithUndo,
      pendingSection: null,
    });

    const alreadyGenerating = current.project.status === "generating";

    if (!alreadyGenerating) {
      await repo.updateProject(designId, { revisionPending: true });
      if (current.project.selectedArtworkVersionId) {
        await repo.supersedeActiveFinalDirectionApproval(designId);
      }
    }

    // True Source-Image Targeted Revision: on a revision turn the customer
    // asked us to change the ARTWORK, so acknowledge the change — not the
    // brief fields extraction happened to touch. "Got it — I have Red in
    // the artwork and the design direction." describes our data model and
    // reads as a misunderstanding. The field-based acknowledgements stay as
    // the fallback for a revision that does not decompose into imperative
    // change clauses, where they are still the most truthful thing to say.
    const requestedChanges = splitRequestedChanges(revisionInstruction);
    const ack =
      acknowledgeRequestedChanges(requestedChanges) ??
      acknowledgeResolvedFields(summaryForAck, impact.changedSections) ??
      acknowledgeRevision(impact.changedSections);
    // "I'm updating the concept now" is only true once something is
    // actually queued. On the enqueue path below, `enqueue` says it itself
    // the moment the job is durable, so claiming it here as well would
    // both duplicate that and survive a failed enqueue as a promise the
    // platform never kept. When a revision is already in flight there is
    // no enqueue to wait for, and the claim is simply true.
    await repo.addMessage(designId, {
      role: "assistant",
      content: alreadyGenerating ? `${ack} ${revisionGeneratingMessage()}` : ack,
      metadata: {
        phase: "revision_received",
        act: "acknowledge",
        updatedSections: impact.changedSections,
        revisionPending: true,
        ...(deferredDecision ? { deferredDecision } : {}),
      },
    });

    if (alreadyGenerating) {
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

    // Live Acceptance Corrective Pass (Section 3): an automatic revision is
    // always a targeted revision of the concept the customer already
    // selected — never a fresh three-direction exploration. A missing
    // selection here is defensive only (this path only ever runs from
    // `handleRevisionReply`, which is only reachable once a concept is
    // selected).
    return current.project.selectedArtworkVersionId
      ? performSelectedConceptRevision(
          designId,
          stateWithUndo,
          current.project.selectedArtworkVersionId,
          revisionInstruction,
        )
      : performRegeneration(designId, stateWithUndo);
  }

  /**
   * Live Acceptance Corrective Pass (Section 2): the customer's explicit
   * "no more changes" confirmation — the sole action that may set
   * `PrintProject.finalDirectionConfirmed = true`. Distinct from, and
   * strictly stronger than, `selectConcept` — selecting only ever means "I
   * want to work with this direction." Requires `artworkVersionId` to
   * match the project's CURRENT selection (never a stale id from an older
   * batch) and requires no revision to currently be pending — confirming
   * "no changes" while a revision is mid-flight would confirm artwork the
   * customer is about to see replaced.
   */
  async function applyConfirmSelectedDirection(
    designId: string,
    current: ProjectSnapshot,
    artworkVersionId: string,
  ): Promise<ProjectSnapshot> {
    if (current.project.selectedArtworkVersionId !== artworkVersionId) {
      throw new Error("Select this concept before confirming it");
    }
    if (current.project.revisionPending) {
      throw new Error(
        "A revision is still in progress — please wait for it to finish first",
      );
    }

    await repo.updateProject(designId, { finalDirectionConfirmed: true });
    await repo.addMessage(designId, {
      role: "assistant",
      content:
        "Great — this is your confirmed direction. Whenever you're ready, I can start preparing your print-ready artwork.",
      metadata: {
        phase: current.conversation.phase,
        act: "final_direction_confirmed",
      },
    });

    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  /**
   * Live Acceptance Cleanup (Issue 5): applies a production-size change.
   *
   * The single most important property here is what it does NOT do. There is
   * no `approveWorkingBrief`, no `reviseSelectedConcept`, no
   * `revisionPending`, and no provider call anywhere on this path: "make the
   * print 12 inches wide" adjusts the production specification and leaves
   * the approved creative artwork exactly as it is. `intendedPrintWidthIn`
   * is excluded from `DesignBriefSnapshotContent` and `diffBriefSections`,
   * so it also cannot mark concepts stale or supersede an approved version.
   *
   * `finalDirectionConfirmed` is likewise untouched — the customer confirmed
   * the DESIGN, and resizing the print does not un-confirm it.
   */
  async function applyProductionPrintWidth(
    designId: string,
    current: ProjectSnapshot,
    requestedWidthIn: number | null,
  ): Promise<ProjectSnapshot> {
    const placement = current.brief.printPlacement;
    if (!placement) {
      throw new Error(
        "I need to know where this prints before I can set a print size",
      );
    }

    // Size is decided BEFORE production starts. Once a plate is being made
    // (or has been made) at a given size, changing the number without
    // re-preparing would make every displayed figure a lie.
    if (current.project.status === "finalizing") {
      throw new Error(
        "Your print-ready artwork is being prepared right now — I can't change the print size until that finishes",
      );
    }
    if (current.project.status === "print_ready") {
      // Existing Artwork → Print Ready Phase 2: for uploaded artwork, changing
      // the size after delivery is ALLOWED, and the guard above is what makes
      // it safe.
      //
      // The asymmetry is real, not an oversight. A create_new customer who
      // wants a different size goes through "Make Another Change", which
      // reopens the creative loop they are still in. An upload customer has no
      // creative loop to reopen — their design is finished and always was, so
      // refusing here would leave them with no route to a different size at
      // all except starting the whole project over.
      //
      // Nothing is overwritten by allowing it: the existing plate stays
      // immutable, the new size gets its OWN finalization job (the
      // preparation + width idempotency key), and until that job completes,
      // `getCurrentProductionAssetId` resolves nothing for the new size —
      // so the customer is never handed a file whose stated size is wrong.
      const preparation = await repo.getArtworkPreparation(designId);
      if (!preparation || preparation.status !== "approved") {
        throw new Error(
          "Your print-ready artwork is already prepared at the size you chose — choose Make Another Change to prepare it at a different size",
        );
      }
      // Back to "artwork approved, production not yet requested" — the
      // truthful description of a project that has an approved design and no
      // print-ready file at the size now intended. The old plate is untouched
      // and still resolvable if they change back.
      await repo.setProjectStatus(designId, "approved");
    }

    const resolved = resolveProductionWidth(placement, requestedWidthIn);
    if (!resolved) {
      throw new Error(
        "I need to know where this prints before I can set a print size",
      );
    }

    await designBrief.setIntendedPrintWidth(
      designId,
      requestedWidthIn === null ? null : resolved.widthIn,
    );

    const updated = await designBrief.getWorkingBrief(designId);
    const size = describePrintReadySize({
      printPlacement: updated.printPlacement,
      intendedPrintWidthIn: updated.intendedPrintWidthIn,
      artworkWidthPx: null,
      artworkHeightPx: null,
    });

    await repo.addMessage(designId, {
      role: "assistant",
      content: productionSizeAcknowledgement(resolved, size?.dpi ?? null),
      metadata: {
        phase: current.conversation.phase,
        act: "production_size_set",
        // Never an ArtworkVersion, never a revision — recorded explicitly so
        // the transcript itself shows this was a production-spec change.
        productionSizeOnly: true,
      },
    });

    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  /** Restores the brief to its state before the most recently accepted revision, if any. */
  async function performUndo(
    designId: string,
    current: ProjectSnapshot,
  ): Promise<ProjectSnapshot> {
    const state = current.conversation.interviewState;

    if (!state.lastRevision) {
      await repo.addMessage(designId, {
        role: "assistant",
        content: "There's nothing to undo right now.",
        metadata: { phase: current.conversation.phase, act: "acknowledge" },
      });
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

    await designBrief.applyProposal(designId, {
      fields: state.lastRevision.previousBrief,
      source: "intent_extraction",
      rationale: "undo_last_revision",
    });
    await repo.updateConversationInterviewState(designId, {
      ...state,
      lastRevision: null,
    });
    await repo.addMessage(designId, {
      role: "assistant",
      content: describeUndo(state.lastRevision.changedSections),
      metadata: {
        phase: current.conversation.phase,
        act: "acknowledge",
        undone: true,
      },
    });

    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  /**
   * Sprint 1/2D behavior, byte-for-byte: one field per fixed phase. Only
   * reachable for a historical project already sitting in an `ask_*` phase.
   */
  async function handleLegacyReply(
    designId: string,
    phase: ConversationPhase,
    trimmed: string,
  ): Promise<ProjectSnapshot> {
    const current = await repo.getProject(designId);
    if (!current) throw new Error("Project not found");

    // Sprint A3: the legacy ladder has no semantic interpretation step, so
    // this gate is deterministic-only — which is exactly the floor every
    // other path also enforces.
    const blocked = await guardCustomerRequest(designId, current, trimmed, null);
    if (blocked) return blocked;

    const extraction = intentExtraction.extract({
      brief: current.brief,
      phase,
      reply: trimmed,
    });
    for (const proposal of extraction.proposals) {
      await designBrief.applyProposal(designId, proposal);
    }

    const nextPhase = nextPhaseAfterUserReply(phase);
    if (!nextPhase) {
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

    if (nextPhase === "ask_design") {
      await repo.setProjectStatus(designId, "intake");
    }

    if (nextPhase === "awaiting_summary_confirmation") {
      const freshBrief = await designBrief.getWorkingBrief(designId);
      await presentDesignSummary(
        designId,
        freshBrief,
        current.conversation.interviewState,
      );
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

    await repo.updateConversationPhase(designId, nextPhase);
    const message = promptForPhase(nextPhase);
    if (message) {
      await repo.addMessage(designId, {
        role: "assistant",
        content: message,
        metadata: { phase: nextPhase },
      });
    }

    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  /**
   * Sprint 2F: Intent Extraction → Design Brief → Brief Evaluation →
   * Design Intelligence → Interview Intelligence → best next act. Used for
   * every new project's pre-approval turn, and for Edit/Continue replies.
   *
   * Sprint 2G Part 2: also computes Revision Impact every turn so
   * Design/Product Intelligence only re-run what the reply actually
   * touched. Sprint 2G Part 3: records a one-level undo snapshot before
   * any accepted change, and flags an explicit deferral with a "Designer
   * Decision" note.
   */
  async function handleAdaptiveReply(
    designId: string,
    phase: ConversationPhase,
    trimmed: string,
  ): Promise<ProjectSnapshot> {
    const current = await repo.getProject(designId);
    if (!current) throw new Error("Project not found");

    const state = current.conversation.interviewState;
    const pendingSection = narrowSection(state.pendingSection);

    if (UNDO_PATTERN.test(trimmed)) {
      return performUndo(designId, current);
    }

    const understanding = await interpretReply(current, current.brief, pendingSection, trimmed);

    // Sprint A3: before a single proposal touches the brief.
    const blocked = await guardCustomerRequest(
      designId,
      current,
      trimmed,
      understanding.ipSignal,
    );
    if (blocked) return blocked;

    const extraction = intentExtraction.extract({
      brief: current.brief,
      phase,
      reply: trimmed,
      pendingSection,
      understanding,
    });
    for (const proposal of extraction.proposals) {
      await designBrief.applyProposal(designId, proposal);
    }

    const workingBrief = await designBrief.getWorkingBrief(designId);
    const impact = revisionIntelligence.analyze(current.brief, workingBrief);
    const evaluation = briefEvaluation.evaluate(workingBrief);
    const assessment = designIntelligence.assess(workingBrief, evaluation, impact);
    const deferredDecision = computeDeferredDecision(current.brief, workingBrief);

    traceConversationUnderstanding({
      stage: "brief_updated",
      resolvedSections: evaluation.sections
        .filter((s) => s.resolution === "provided" || s.resolution === "deferred_to_designer")
        .map((s) => s.section),
    });

    const act = interviewIntelligence.selectNextAct({
      evaluation,
      assessment,
      context: {
        pendingSection,
        askCounts: state.askCounts,
        dismissedAdvisories: state.dismissedAdvisories,
      },
    });

    traceConversationUnderstanding({
      stage: "next_act",
      actType: act.type,
      section: actSection(act) ?? null,
      pendingSection,
    });

    const stateWithUndo: InterviewStateData = impact.isNoOp
      ? state
      : {
          ...state,
          lastRevision: {
            previousBrief: toDesignBriefSnapshotContent(current.brief),
            changedSections: impact.changedSections,
          },
        };

    if (act.type === "summarize") {
      await presentDesignSummary(designId, workingBrief, stateWithUndo, {
        previousBrief: current.brief,
        // Live Acceptance Cleanup (UPDATED badge): the summary highlights
        // what the customer CHANGED, which is a strictly narrower set than
        // what changed in the brief — answering a question for the first
        // time populates a field, it does not update one.
        updatedSections: diffEstablishedBriefSections(
          current.brief,
          workingBrief,
        ),
      });
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

    const nextState = applyActToInterviewState(stateWithUndo, act);
    await repo.updateConversationPhase(designId, "interviewing");
    await repo.updateConversationInterviewState(designId, nextState);

    if (act.type !== "await_customer") {
      const summaryForAck = designSummary.createSummary(workingBrief, evaluation);
      await repo.addMessage(designId, {
        role: "assistant",
        content: withResolvedAcknowledgement(
          act,
          impact.changedSections,
          summaryForAck,
          naturalizeQuestion(act, summaryForAck),
        ),
        metadata: {
          phase: "interviewing",
          act: act.type,
          section: actSection(act),
          ...(deferredDecision ? { deferredDecision } : {}),
          ...(act.type === "advise"
            ? { actions: findRecommendationActions(assessment, act.findingId) }
            : {}),
        },
      });
    }

    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  /**
   * Sprint 2G Part 2: adaptive post-concept revision handling. Never
   * restarts the interview and never re-asks an already-answered question
   * unless this revision itself invalidated it.
   *
   * Sprint 2G Part 3: concept regeneration is no longer a one-shot yes/no
   * gate on the *next* reply — "regenerate"/"keep current" are recognized
   * whenever concepts actually need it, on any turn, and an ignored prompt
   * never blocks or repeats. One level of undo is available here too.
   */
  async function handleRevisionReply(
    designId: string,
    phase: ConversationPhase,
    trimmed: string,
  ): Promise<ProjectSnapshot> {
    const current = await repo.getProject(designId);
    if (!current) throw new Error("Project not found");

    const state = current.conversation.interviewState;
    await repo.setProjectStatus(designId, "revision_requested");

    if (UNDO_PATTERN.test(trimmed)) {
      return performUndo(designId, current);
    }

    // Live Acceptance Corrective Pass (Section 2): checked unconditionally,
    // ahead of everything else — an explicit "no changes" confirmation is
    // never gated on concept staleness.
    if (
      CONFIRM_FINAL_PATTERN.test(trimmed) &&
      current.project.selectedArtworkVersionId &&
      !current.project.revisionPending
    ) {
      return applyConfirmSelectedDirection(
        designId,
        current,
        current.project.selectedArtworkVersionId,
      );
    }

    // Live Acceptance Corrective Pass (Section 3): an explicit request for
    // alternatives always explores three fresh directions, even though the
    // default post-selection revision now targets just the one selected
    // concept. Checked unconditionally, ahead of the staleness-gated
    // manual-regenerate pattern below.
    if (ALTERNATIVES_REQUEST_PATTERN.test(trimmed)) {
      return performRegeneration(designId, state);
    }

    // Live Acceptance Cleanup (Issue 5): a PRODUCTION-SIZE request is not a
    // creative revision and must never reach the revision pipeline. Checked
    // only once the customer has confirmed their final direction — that is
    // the "Use This Design → Prepare Print-Ready" boundary where print size
    // is the live question, and gating it there is what keeps an earlier
    // "make it bigger" reading as the creative instruction it almost
    // certainly is. See `shared/production-size-intent.ts`.
    if (current.project.finalDirectionConfirmed) {
      const sizeIntent = detectProductionSizeIntent(trimmed);
      if (sizeIntent) {
        const currentWidth = resolveProductionWidth(
          current.brief.printPlacement,
          current.brief.intendedPrintWidthIn,
        );
        const requestedWidthIn =
          sizeIntent.kind === "absolute"
            ? sizeIntent.widthIn
            : (currentWidth?.widthIn ?? 0) +
              (sizeIntent.direction === "larger"
                ? RELATIVE_SIZE_STEP_IN
                : -RELATIVE_SIZE_STEP_IN);
        return applyProductionPrintWidth(designId, current, requestedWidthIn);
      }
    }

    const conceptStatus = conceptGeneration.describeConceptStatus(
      current.brief,
      current.artworkVersions,
      current.designBriefVersions,
    );
    if (conceptStatus.status === "needs_update") {
      if (REGENERATE_REQUEST_PATTERN.test(trimmed)) {
        // Live Acceptance Corrective Pass (Section 3): the manual
        // "regenerate" control defaults to revising the selected concept,
        // same as the automatic path — never three unrelated directions,
        // unless `ALTERNATIVES_REQUEST_PATTERN` (checked above) explicitly
        // asked for that.
        return current.project.selectedArtworkVersionId
          ? performSelectedConceptRevision(
              designId,
              state,
              current.project.selectedArtworkVersionId,
              // No literal delta: "regenerate" is a command to apply
              // changes already captured in the brief, not itself a
              // description of a change. Prompt Translation falls back to
              // the RegenerationPlan's section-level changes, which is the
              // correct source for this path.
              null,
            )
          : performRegeneration(designId, state);
      }
      if (KEEP_CONCEPTS_PATTERN.test(trimmed)) {
        await repo.addMessage(designId, {
          role: "assistant",
          content:
            "No problem — I'll leave the current concepts as they are. Anything else you'd like to change?",
          metadata: { phase: "revision_received", act: "acknowledge" },
        });
        const snapshot = await repo.getProject(designId);
        if (!snapshot) throw new Error("Project not found");
        return snapshot;
      }
    }

    const previousBrief = current.brief;
    const pendingSection = narrowSection(state.pendingSection);

    const understanding = await interpretReply(current, previousBrief, pendingSection, trimmed);

    // Sprint A3: a safe project can be turned unsafe by a single revision
    // ("now put the Raiders logo on it"). Blocking here — before extraction,
    // before `triggerAutomaticRevision`, before any enqueue — is why a
    // revision never reaches a paid provider. The selected concept, the
    // brief, `revisionPending`, and any final-direction approval are all
    // left exactly as they were (the `revision_requested` status above is
    // written for every message in this loop and means only "the customer
    // is talking about changes", never that one was accepted).
    const blocked = await guardCustomerRequest(
      designId,
      current,
      trimmed,
      understanding.ipSignal,
    );
    if (blocked) return blocked;

    const extraction = intentExtraction.extract({
      brief: previousBrief,
      phase,
      reply: trimmed,
      pendingSection,
      understanding,
    });
    for (const proposal of extraction.proposals) {
      await designBrief.applyProposal(designId, proposal);
    }

    const updatedBrief = await designBrief.getWorkingBrief(designId);
    const impact = revisionIntelligence.analyze(previousBrief, updatedBrief);
    const deferredDecision = computeDeferredDecision(previousBrief, updatedBrief);

    if (impact.isNoOp) {
      // Nothing structured changed — unstructured feedback was already
      // preserved as a note by extraction. Stay in the loop.
      await repo.updateConversationPhase(designId, "revision_received");
      await repo.addMessage(designId, {
        role: "assistant",
        content:
          "Got it — I've noted that. Anything else you would like to adjust?",
        metadata: {
          phase: "revision_received",
          ...(deferredDecision ? { deferredDecision } : {}),
        },
      });
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

    const stateWithUndo: InterviewStateData = {
      ...state,
      lastRevision: {
        previousBrief: toDesignBriefSnapshotContent(previousBrief),
        changedSections: impact.changedSections,
      },
    };

    const evaluation = briefEvaluation.evaluate(updatedBrief);
    const assessment = designIntelligence.assess(updatedBrief, evaluation, impact);
    const act = interviewIntelligence.selectRevisionAct({
      evaluation,
      assessment,
      impact,
      context: {
        pendingSection,
        askCounts: state.askCounts,
        dismissedAdvisories: state.dismissedAdvisories,
      },
    });

    if (act.type === "clarify" || act.type === "advise") {
      const nextState = applyActToInterviewState(stateWithUndo, act);
      await repo.updateConversationPhase(designId, "revision_received");
      await repo.updateConversationInterviewState(designId, nextState);
      await repo.addMessage(designId, {
        role: "assistant",
        content: act.message,
        metadata: {
          phase: "revision_received",
          act: act.type,
          section: actSection(act),
          ...(deferredDecision ? { deferredDecision } : {}),
          ...(act.type === "advise"
            ? { actions: findRecommendationActions(assessment, act.findingId) }
            : {}),
        },
      });
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

    // The revision was unambiguous and raised nothing new — continue
    // naturally. Only mention regenerating concepts if some already exist
    // and this change would actually make them stale; the persistent
    // concept-status action (not this message) is what actually lets the
    // customer act on it whenever they're ready.
    const hasExistingConcepts = current.artworkVersions.length > 0;
    const shouldMentionRegeneration =
      impact.needsConceptRegeneration && hasExistingConcepts;

    // Sprint 2M Phase 2G (Goal 3/4/6/7): an explicit, unambiguous customer
    // instruction that touches a concept-relevant field is customer
    // authority to regenerate automatically — no "Generate Updated
    // Concepts" click required (AGENTS.md/ARCHITECTURE.md: system-initiated
    // speculative regeneration remains forbidden; customer-requested
    // conversational revision does not). "Maybe...", "I'm not sure...", and
    // bare questions never reach this branch — see `isExplicitRevisionIntent`.
    if (shouldMentionRegeneration && isExplicitRevisionIntent(trimmed)) {
      const summaryForAck = designSummary.createSummary(updatedBrief, evaluation);
      return triggerAutomaticRevision(
        designId,
        current,
        stateWithUndo,
        impact,
        summaryForAck,
        deferredDecision,
        trimmed,
      );
    }

    await repo.updateConversationPhase(designId, "revision_received");
    await repo.updateConversationInterviewState(designId, {
      ...stateWithUndo,
      pendingSection: null,
    });
    await repo.addMessage(designId, {
      role: "assistant",
      content: shouldMentionRegeneration
        ? `${acknowledgeRevision(impact.changedSections)} ${conceptRegenerationPrompt()}`
        : acknowledgeRevision(impact.changedSections),
      metadata: {
        phase: "revision_received",
        act: "acknowledge",
        updatedSections: impact.changedSections,
        ...(deferredDecision ? { deferredDecision } : {}),
      },
    });

    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  return {
    start(acquisitionSessionId = null) {
      return repo.createProject(acquisitionSessionId);
    },

    get(designId) {
      return repo.getProject(designId);
    },

    async handleUserMessage(designId, content) {
      const trimmed = content.trim();
      if (!trimmed) throw new Error("Message cannot be empty");

      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");

      const phase = current.conversation.phase;

      if (CHAT_BLOCKED_PHASES.includes(phase)) {
        throw new Error("Please wait for the current step to finish");
      }

      // Sprint A4 — THE EMAIL GATE. Continuing the design conversation is
      // the "next meaningful progression" the free concept is traded for,
      // so this is the narrowest place the gate belongs (Goal 6).
      //
      // Deliberately NOT applied to reading the project, viewing the
      // concept image, selecting, or unselecting: the customer must be able
      // to actually SEE and consider what they were shown before being
      // asked for anything, and none of those actions can reach paid work
      // (generation and finalization carry their own independent fences).
      //
      // Also deliberately conditioned on the concept having been DELIVERED.
      // A prospect whose concept is still generating has not received the
      // value yet, and asking them for an address mid-wait would be a toll
      // booth in front of a promise we have not kept.
      //
      // Sprint A4 Correction C2: this used to pass
      // `current.artworkVersions.length > 0` as that condition — a second,
      // staler copy of a rule the acquisition capability owns, which
      // counted a `prepared_upload` row (the Existing Artwork customer's
      // own pixels) and an artwork row written mid-generation as delivered
      // free concepts. Delivery is now resolved inside the capability, from
      // the session, so every surface that can ask for an address agrees.
      //
      // The customer's message is refused BEFORE it is persisted — a turn
      // that is not going to be answered should not appear in the
      // transcript as if it had been.
      const continuation =
        await acquisition.authorizeSessionContinuation(designId);
      if (!continuation.allowed) {
        await repo.addMessage(designId, {
          role: "assistant",
          content: continuation.customerMessage,
          // Generic metadata for the same reason the IP-safety gate uses
          // generic metadata: `ProjectSnapshot.messages` is client-visible,
          // so a reason code here would leak the internal state machine.
          metadata: { phase, act: "acknowledge" },
        });
        const gated = await repo.getProject(designId);
        if (!gated) throw new Error("Project not found");
        return gated;
      }

      await repo.addMessage(designId, {
        role: "user",
        content: trimmed,
        metadata: { phase },
      });

      if (isLegacyScriptedPhase(phase)) {
        return handleLegacyReply(designId, phase, trimmed);
      }
      if (REVISION_REQUEST_PHASES.includes(phase)) {
        return handleRevisionReply(designId, phase, trimmed);
      }
      return handleAdaptiveReply(designId, phase, trimmed);
    },

    async selectConcept(designId, artworkVersionId) {
      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");

      // Live Acceptance Corrective Pass (Section 4, Goal 24): reachable
      // from `concepts_ready` (the normal path) AND from the post-
      // selection revision loop, so the customer can explicitly return to
      // an earlier concept — original or a prior revision, any historical
      // batch, never just the newest one (`artworkVersions` is never
      // filtered to "current" below) — after deciding a revision was worse.
      if (
        current.conversation.phase !== "concepts_ready" &&
        !REVISION_REQUEST_PHASES.includes(current.conversation.phase)
      ) {
        throw new Error("Concepts are not ready for selection");
      }

      const exists = current.artworkVersions.some(
        (version) => version.id === artworkVersionId,
      );
      if (!exists) throw new Error("Concept not found");

      await repo.selectArtworkVersion(designId, artworkVersionId);
      // Live Acceptance Corrective Pass (Section 2): every new selection —
      // including re-selecting a different concept after a revision —
      // starts unconfirmed. Only an explicit "no changes"/"Use This
      // Design" action may set this back to true.
      await repo.updateProject(designId, { finalDirectionConfirmed: false });
      await repo.updateConversationPhase(designId, "ask_revisions");
      await repo.addMessage(designId, {
        role: "assistant",
        content: "What changes would you like to make to this concept?",
        metadata: { phase: "ask_revisions" },
      });

      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    },

    async unselectConcept(designId) {
      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");

      // Already unselected — idempotent, and never posts a second message.
      if (!current.project.selectedArtworkVersionId) return current;

      // A revision in flight was requested FOR the current selection.
      // Dropping the selection underneath it would leave a running job
      // producing artwork for a concept the project no longer points at.
      if (current.project.revisionPending) {
        throw new Error(
          "I'm still updating this concept — once it's ready you can change your selection",
        );
      }

      // Never silently invalidate production work. `finalizing` has a
      // claimable/running FinalArtworkJob behind it, and `print_ready` has a
      // delivered asset the customer is looking at; both are explicit
      // lifecycle states with their own exits ("Make Another Change"), not
      // something a selection change may quietly undo.
      if (current.project.status === "finalizing") {
        throw new Error(
          "Your print-ready artwork is being prepared right now — I can't change the selection until that finishes",
        );
      }
      if (current.project.status === "print_ready") {
        throw new Error(
          "Your print-ready artwork is already prepared — choose Make Another Change if you'd like to keep working on the design",
        );
      }

      // An approval for a no-longer-selected concept must never stay active:
      // `FinalArtworkWorkerCapability` only ever acts on the ACTIVE approval,
      // so superseding here is what stops a late/recovered job from
      // finalizing artwork the customer has stepped away from. Superseding
      // never deletes the record (Constitution §6.11).
      const activeApproval =
        await repo.getActiveFinalDirectionApproval(designId);
      if (activeApproval) {
        await repo.supersedeActiveFinalDirectionApproval(designId);
      }

      await repo.clearArtworkSelection(designId);
      await repo.updateConversationPhase(designId, "concepts_ready");
      await repo.addMessage(designId, {
        role: "assistant",
        content:
          "No problem — nothing is selected now. Take another look and choose the direction you'd like to work with.",
        metadata: { phase: "concepts_ready", act: "selection_cleared" },
      });

      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    },

    async exploreNewConceptBatch(designId) {
      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");

      const approved = await designBrief.getLatestApprovedVersion(designId);
      if (!approved) {
        throw new Error(
          "Cannot generate concepts without an approved design brief",
        );
      }

      // Idempotent at this boundary too, so a double click never even
      // reaches the enqueue path (which is independently idempotent).
      if (current.project.status === "generating") return current;
      if (current.project.revisionPending) {
        throw new Error(
          "I'm still updating your concept — once it's ready I can explore new directions",
        );
      }
      if (
        current.project.status === "finalizing" ||
        current.project.status === "print_ready"
      ) {
        throw new Error(
          "Your print-ready artwork is already being prepared — choose Make Another Change if you'd like to keep exploring",
        );
      }

      // Deliberately does NOT re-approve the working brief: the whole point
      // is that the brief is right and only the creative directions were
      // wrong. Nothing about the brief, the selection, or any prior batch
      // changes here.
      return conceptGeneration.exploreNewConceptBatch(designId, approved.id);
    },

    async setProductionPrintWidth(designId, requestedWidthIn) {
      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");
      return applyProductionPrintWidth(designId, current, requestedWidthIn);
    },

    async approveFinalDirection(designId, artworkVersionId) {
      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");

      const result = await finalArtwork.requestFinalArtwork(
        designId,
        artworkVersionId,
      );

      // Idempotent retry (double-click, duplicate request, reload) never
      // posts a second acknowledgement message.
      if (!result.alreadyRequested) {
        await repo.addMessage(designId, {
          role: "assistant",
          content:
            "Thanks — I've noted this as your final direction. I'm preparing your print-ready artwork now.",
          metadata: {
            phase: current.conversation.phase,
            act: "final_direction_approved",
          },
        });
      }

      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    },

    async submitDesignBriefDecision(designId, action) {
      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");
      const phase = current.conversation.phase;

      if (action === "approve") {
        if (phase === "awaiting_summary_confirmation") {
          return approveAndGenerate(designId);
        }

        // Idempotent retry: approval already happened for this brief
        // content — never re-approve, never duplicate concepts.
        if (POST_APPROVAL_PHASES.includes(phase)) {
          const latest = await designBrief.getLatestApprovedVersion(designId);
          if (latest) {
            // An approved brief does not prove generation was ever
            // requested. Approval and enqueue are separate writes with no
            // shared transaction, so an earlier attempt can have persisted
            // the version, phase, and status and then failed before the
            // `GenerationJob` existed — a project stuck forever, since
            // nothing downstream polls a project that never reached
            // "generating". Re-entering enqueue is what makes Approve
            // retry-safe. It is idempotent per (project, approved
            // version): an existing queued/running job is returned
            // untouched rather than duplicated.
            if (current.artworkVersions.length === 0) {
              return conceptGeneration.generatePlaceholders(
                designId,
                latest.id,
              );
            }

            const snapshot = await repo.getProject(designId);
            if (!snapshot) throw new Error("Project not found");
            return snapshot;
          }
        }

        throw new Error("Design summary is not ready for approval");
      }

      if (phase !== "awaiting_summary_confirmation") {
        throw new Error(
          `Cannot ${action} the design brief from the current step`,
        );
      }

      // "edit" is the only remaining non-approve action (Sprint 2L Phase
      // 1B, Goal 12 — "continue" removed as redundant; see schema.ts).
      await repo.updateConversationPhase(designId, "edit_requested");
      await repo.addMessage(designId, {
        role: "assistant",
        content: "What would you like to change or add?",
        metadata: { phase: "edit_requested" },
      });

      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    },

    async regenerateConcepts(designId) {
      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");
      if (current.designBriefVersions.length === 0) {
        throw new Error(
          "Cannot generate concepts without an approved design brief",
        );
      }
      // Sprint 2M Phase 2G (Goal 4/8): idempotent — a regeneration may
      // already be in flight (e.g. auto-enqueued by an explicit
      // conversational revision); pressing "Generate Updated Concepts" on
      // top of that must never create a second brief version/job.
      if (current.project.status === "generating") {
        return current;
      }
      // Live Acceptance Corrective Pass (Section 3): the persistent
      // "Generate Updated Concepts" control defaults to revising the
      // selected concept, same as every other post-selection revision path
      // — three-direction exploration only when nothing is selected yet
      // (pre-selection edge case).
      return current.project.selectedArtworkVersionId
        ? performSelectedConceptRevision(
            designId,
            current.conversation.interviewState,
            current.project.selectedArtworkVersionId,
            // A button press carries no literal delta — the changes are
            // already in the brief. See the same fallback above.
            null,
          )
        : performRegeneration(designId, current.conversation.interviewState);
    },

    async recoverInterruptedGenerationRequest(designId) {
      const current = await repo.getProject(designId);
      if (!current) return null;

      // Mutually exclusive in practice: the approval repair requires the
      // project to have no generation job at all, which a project far
      // enough along to have a pending revision never satisfies.
      const afterApproval = await completeInterruptedApproval(designId, current);
      return completeInterruptedRevision(designId, afterApproval);
    },

    async confirmSelectedDirection(designId, artworkVersionId) {
      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");
      return applyConfirmSelectedDirection(designId, current, artworkVersionId);
    },

    async undoLastChange(designId) {
      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");
      return performUndo(designId, current);
    },
  };
}

/**
 * Sprint 2L Phase 1 (Goal 13), refined Sprint 2L Phase 1A, refined again
 * Sprint 2L Phase 1B (Goal 7): when this turn resolved one or more brief
 * sections before asking/clarifying the next one, lead with a short,
 * deterministic acknowledgement instead of asking as if nothing had been
 * said. The acknowledgement's *shape* now depends on how much actually
 * happened this turn:
 *
 *   - A single low-salience field answer ("black" → product color) gets a
 *     short, natural confirmation (`shortAcknowledgement` — "Black
 *     works.") — the full "Got it — I have Black as the shirt color."
 *     treatment reads as database-mutation reporting when it repeats
 *     every single turn (the live acceptance test's core complaint).
 *   - A multi-field turn (a rich customer message resolved several things
 *     at once) still earns the fuller `acknowledgeResolvedFields`
 *     synthesis — demonstrating real understanding of a complex message
 *     is exactly when that detail is worth showing.
 *
 * `acknowledgeResolvedFields` only ever names a section that both changed
 * this turn AND has a real, resolved value in `summary` (the Design
 * Summary of the post-patch brief) — a field a provider proposed but that
 * reconciliation rejected (failed grounding, ambiguous confidence,
 * unsupported section, ...) never appears here, because it was never
 * applied and therefore never changed the brief. Falls back to the terser
 * `acknowledgeRevision` only when nothing changed has a displayable value
 * (e.g. the sole change was a deferral) — that generic phrasing remains
 * truthful in that case. Never applied to "advise" acts (an advisory
 * already has its own framing) or when nothing changed this turn.
 */
function withResolvedAcknowledgement(
  act: InterviewAct,
  changedSections: BriefSectionKey[],
  summary: DesignSummaryView,
  /** Already-naturalized question text for "ask" acts (see `naturalizeQuestion`) — falls back to `act.message` for every other act type. */
  questionMessage: string,
): string {
  if (act.type !== "ask" && act.type !== "clarify") {
    // Only "advise" reaches here in practice (the caller already returned
    // early for "summarize" and skips "await_customer" entirely) — the
    // `"message" in act` guard keeps this exhaustive/type-safe without a
    // cast rather than assuming that.
    return "message" in act ? act.message : "";
  }
  if (changedSections.length === 0) return questionMessage;

  if (changedSections.length === 1) {
    const [section] = changedSections;
    const value = (summary[section as keyof DesignSummaryView] as string | undefined) ?? null;
    return `${shortAcknowledgement(section, value)} ${questionMessage}`;
  }

  const ack =
    acknowledgeResolvedFields(summary, changedSections) ?? acknowledgeRevision(changedSections);
  return `${ack} ${questionMessage}`;
}

/**
 * Sprint 2L Phase 1B (Goal 9), corrected Sprint 2L Phase 1C: a light,
 * deterministic naturalization of the next question using only
 * already-CONFIRMED brief values — never a new LLM call, never an
 * invented fact. Scoped to the two questions a live acceptance test
 * called out as reading generically once real context is already known
 * ("What color garment..." → "What color T-shirts...", "Tell me about
 * the design..." → "What direction do you want for the My 3 Sons
 * design?"). Every other question keeps its existing, already-tested
 * phrasing untouched. `InterviewIntelligenceCapability` itself stays
 * brief-unaware (capability-boundaries.ts forbids it inspecting the
 * brief) — this naturalization happens here, in Conversation
 * orchestration, which already has full brief access for other reasons
 * (building the acknowledgement, the understanding request).
 *
 * Sprint 2L Phase 1C fix: takes the already-computed `DesignSummaryView`
 * (the same `summaryForAck` the acknowledgement uses), never the raw
 * `TShirtDesignBrief`. A live acceptance test found that a raw brief field
 * can hold a value `BriefEvaluation` has already rejected as malformed
 * (e.g. a punctuation-free run-on sentence a deterministic extractor
 * greedily over-captured into `exactText`) — quality-rejected, so it
 * correctly stays `"unknown"` for readiness purposes and never reaches
 * the customer-facing Design Summary, but the *raw field* is never
 * cleared, only its evaluation status is. Reading the raw field here
 * bypassed that quality gate entirely and leaked the rejected value
 * straight into a customer-facing question
 * ("What direction do you want for the My 3 Sons help me create a
 * design for team t-shirts design?"). `DesignSummaryView` is exactly the
 * quality-gated projection — a field only appears in it when
 * `BriefEvaluation` has already confirmed `resolution === "provided"` —
 * so this naturalization can never surface a value the customer wouldn't
 * also see reflected in the Design Summary itself.
 */
function naturalizeQuestion(act: InterviewAct, summary: DesignSummaryView): string {
  if (act.type !== "ask") return "message" in act ? act.message : "";

  if (act.section === "productColor") {
    // Only a value that actually names a print product may be inflected
    // into a question. Appending "s" to whatever the Product field held
    // produced "What color Designs will these print on?" from a brief
    // that had recorded the word "design" as the product — grammar
    // derived from raw customer text, asked with total confidence.
    // Anything else falls through to the generic phrasing, which is
    // always true.
    const product = productNameForQuestion(summary.product);
    if (product) return `What color ${product} will you be printing on?`;
  }

  if (act.section === "graphics") {
    const subject = summary.requiredWording?.trim();
    // "None" is DesignSummaryView's own sentinel for an explicit,
    // confirmed "no required wording" — never a usable subject phrase.
    const wordingSubject = subject && subject !== "None" ? subject : null;
    const audienceSubject = summary.audience?.trim();
    const finalSubject = wordingSubject || audienceSubject;
    if (finalSubject) return `What direction do you want for the ${finalSubject} design?`;
  }

  return act.message;
}

function narrowSection(pending: string | null): BriefSectionKey | null {
  if (pending && KNOWN_SECTIONS.has(pending)) {
    return pending as BriefSectionKey;
  }
  return null;
}

function applyActToInterviewState(
  state: InterviewStateData,
  act: InterviewAct,
): InterviewStateData {
  if (act.type === "ask" || act.type === "clarify") {
    return {
      ...state,
      pendingSection: act.section,
      askCounts: {
        ...state.askCounts,
        [act.section]: (state.askCounts[act.section] ?? 0) + 1,
      },
    };
  }
  if (act.type === "advise") {
    return {
      ...state,
      pendingSection: act.followUpSection ?? state.pendingSection,
      dismissedAdvisories: [...state.dismissedAdvisories, act.findingId],
    };
  }
  return state; // "await_customer" — defensive fallback, no state change.
}

function actSection(act: InterviewAct): string | undefined {
  if (act.type === "ask" || act.type === "clarify") return act.section;
  if (act.type === "advise") return act.followUpSection;
  return undefined;
}

/**
 * Sprint 2G Part 3: old → new value for every updated, currently-visible
 * field — the raw material for "Black → Navy" styling. A section that
 * changed but isn't shown in the summary (e.g. it's now deferred) has no
 * entry; a section whose displayed value didn't actually change (only
 * bookkeeping did) is also skipped.
 */
function buildFieldTransitions(
  previousSummary: DesignSummaryView,
  newSummary: DesignSummaryView,
  updatedSections: BriefSectionKey[],
): Record<string, { from: string | null; to: string }> {
  const transitions: Record<string, { from: string | null; to: string }> = {};
  for (const section of updatedSections) {
    const key = section as keyof DesignSummaryView;
    const to = newSummary[key];
    if (!to) continue;
    const from = previousSummary[key] ?? null;
    if (from === to) continue;
    transitions[section] = { from, to };
  }
  return transitions;
}

/** The section, if any, the customer just explicitly deferred this turn. */
function computeDeferredDecision(
  previousBrief: TShirtDesignBrief,
  updatedBrief: TShirtDesignBrief,
): { section: BriefSectionKey; message: string } | null {
  const previousSet = new Set(previousBrief.deferredSections);
  const newlyDeferred = updatedBrief.deferredSections.find(
    (section) => !previousSet.has(section),
  );
  if (!newlyDeferred || !KNOWN_SECTIONS.has(newlyDeferred)) return null;
  const section = newlyDeferred as BriefSectionKey;
  return { section, message: designerDecisionMessage(section) };
}

/**
 * Looks up the clickable actions for the recommendation an "advise" act
 * came from, so the recommendation card can render them — `InterviewAct`
 * itself only carries `findingId`/`message`, not the full recommendation.
 */
function findRecommendationActions(
  assessment: IntelligenceAssessment,
  findingId: string,
) {
  return assessment.recommendations.find((r) => r.id === findingId)?.actions ?? [];
}

/**
 * True Source-Image Targeted Revision: the customer's most recent message.
 *
 * Used only by `completeInterruptedRevision`, where the durable
 * `revisionInstruction` was never written because the process died between
 * marking the revision pending and enqueueing the job. The message log is
 * the durable record of what they asked for, and on that path the last
 * customer message IS the revision request — resuming without it would
 * hand the provider a source image and no delta.
 */
function latestCustomerMessage(project: ProjectSnapshot): string | null {
  for (let i = project.messages.length - 1; i >= 0; i -= 1) {
    const message = project.messages[i];
    if (message?.role !== "user") continue;
    const trimmed = message.content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

// Re-exported only so downstream call sites can type revision-derived
// context without importing `@/capabilities/shared/contracts` directly.
export type { RevisionImpact };
