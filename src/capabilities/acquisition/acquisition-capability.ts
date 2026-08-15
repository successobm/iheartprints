import { randomBytes } from "crypto";

import { hasDeliveredGeneratedConcept } from "@/capabilities/shared/concept-delivery";
import type { ProjectRepository } from "@/lib/db/repository";
import type { AcquisitionSession } from "@/lib/domain/types";

import {
  ACQUISITION_UNAVAILABLE_MESSAGE,
  EMAIL_REQUIRED_CONVERSATION_MESSAGE,
  FREE_CONCEPT_SPENT_MESSAGE,
  PAID_FINALIZATION_LOCKED_MESSAGE,
  PAID_GENERATION_LOCKED_MESSAGE,
} from "./acquisition-copy";
import { validateEmail } from "./acquisition-email";

/**
 * Sprint A4: the acquisition entitlement boundary.
 *
 * WHAT THIS CAPABILITY OWNS
 *
 *   - the anonymous acquisition session (issue, resolve)
 *   - the one-free-concept entitlement (authorize, allocate, consume)
 *   - the email-to-continue gate
 *   - the internal entitlement grant
 *   - the customer-safe description of all of the above
 *
 * WHAT IT DELIBERATELY DOES NOT OWN
 *
 *   - payment, pricing, checkout, subscriptions (Sprint A5)
 *   - authentication, accounts, passwords, verified identity
 *   - marketing consent, CRM, email delivery
 *   - fraud detection, device fingerprinting, IP-based identity
 *
 * THE AUTHORITY MODEL, stated once
 *
 * Every paid-value decision resolves authority from the PROJECT, via
 * `PrintProject.acquisitionSessionId`, and never from anything the caller
 * supplied. That single choice is what makes the gate un-bypassable from a
 * client (Goal 17): clearing the cookie, forging one, or calling the API
 * with no cookie at all changes nothing, because the project already knows
 * which session it belongs to.
 *
 * The cookie's only job is deciding which session a BRAND NEW project is
 * created under. That is also the honest limit of the anti-abuse claim:
 * someone who clears cookies, opens another browser, or uses another device
 * gets a new session and another free concept. A4 is spend control, not
 * surveillance — no fingerprinting, no IP-as-identity — and that limitation
 * is documented rather than hidden.
 *
 * ALLOCATION vs CONSUMPTION
 *
 * The entitlement moves through two distinct states, and conflating them
 * would either burn a customer's free concept for a failure that was ours,
 * or hand out a second one:
 *
 *   ALLOCATED  — reserved for a project, atomically, before any generation
 *                job exists. Two racing requests resolve to one allocation.
 *                Costs nothing: an enqueue that fails before a durable job
 *                exists leaves the free concept intact and re-requesting on
 *                the same project simply resumes.
 *
 *   CONSUMED   — a durable `GenerationJob` exists. This is the point the
 *                platform has committed to a recoverable, idempotent,
 *                spend-bounded paid attempt (`paid_image_intents` bounds
 *                what that job may ever spend). Irreversible: no second
 *                free generation is authorized for this session, ever —
 *                including on the same project.
 */

/**
 * The reason a generation request was authorized or refused. Internal —
 * `customerMessage` is the only thing that may reach a browser.
 */
export type ConceptGenerationAuthorization =
  | {
      allowed: true;
      /**
       * `"free_concept"` is the ONE free acquisition concept and produces
       * exactly one customer-visible concept. `"entitled"` is an internal
       * or legacy-unbound project, which keeps the pre-A4 batch behavior.
       */
      grant: "free_concept" | "entitled";
      /** Only set for `"free_concept"` — the session to bind the job to. */
      sessionId: string | null;
    }
  | {
      allowed: false;
      reason:
        | "email_required"
        | "paid_access_required"
        /**
         * Sprint A4 Correction 1: the project names an acquisition session
         * that cannot be loaded. See `resolveAuthority` for why this is a
         * refusal rather than a fall-through to legacy.
         */
        | "authority_unavailable";
      customerMessage: string;
    };

/**
 * Sprint A4 Correction 1: the three genuinely different answers to "what is
 * this project's acquisition authority?".
 *
 * The middle case is the correction. Before it, a project whose bound
 * session could not be loaded returned the same `null` as a project that was
 * never bound at all — and `null` means LEGACY, which the product
 * grandfathers into unrestricted generation and finalization. A deleted,
 * corrupted, or unreadable session therefore GRANTED unlimited free
 * generation. The whole point of the entitlement is that losing a row must
 * never be the thing that hands out spend.
 *
 *   "legacy"      project.acquisitionSessionId IS NULL — genuinely predates
 *                 the acquisition funnel. Grandfathered, deliberately.
 *   "unavailable" project names a session that cannot be loaded. FAILS
 *                 CLOSED. Never legacy, never internal.
 *   "session"     the real, loaded authority.
 */
type ResolvedAuthority =
  | { kind: "legacy" }
  | { kind: "unavailable" }
  | { kind: "session"; session: AcquisitionSession };

export type FinalizationAuthorization =
  | { allowed: true }
  | { allowed: false; customerMessage: string };

/**
 * Customer-safe acquisition state. Deliberately NOT the persisted
 * entitlement enum (Goal 12): `"internal"` never appears here, because a
 * customer surface has no business knowing that tier exists, and
 * `"prospect"` is meaningless to the person it describes.
 *
 *   "open"                    — nothing is gated right now. Covers a fresh
 *                               prospect whose free concept is still
 *                               available, and (indistinguishably, on
 *                               purpose) an internal or legacy project.
 *   "free_concept_generating" — their concept is being made.
 *   "email_required"          — their concept exists; an address unlocks
 *                               continuing the session.
 *   "continue_locked"         — address on file; further design work needs
 *                               access this product does not sell yet.
 *   "unavailable"             — Sprint A4 Correction 1. The server cannot
 *                               currently establish what this session may
 *                               do. Shown INSTEAD of `"open"` whenever
 *                               authority resolution fails, because `"open"`
 *                               would promise actions the server is about to
 *                               refuse. Says nothing about why.
 */
export type CustomerAcquisitionState =
  | "open"
  | "free_concept_generating"
  | "email_required"
  | "continue_locked"
  | "unavailable";

export interface CustomerAcquisitionView {
  state: CustomerAcquisitionState;
  /**
   * Plain-language copy for the current state, or `null` when there is
   * nothing to say. Never a reason code, never an internal term. The email
   * ADDRESS is deliberately absent from this view entirely — the UI does
   * not need it to render a gate, and not returning it is the cheapest
   * possible way to keep it out of caches, logs, and screenshots (Goal 19).
   */
  message: string | null;
  /** Whether the gate has been satisfied. Never the address itself. */
  emailCaptured: boolean;
}

/**
 * Deliberately carries no state view on success. The caller re-reads the
 * project snapshot, so the state a customer is shown after capturing an
 * address comes from the same derivation as every other read rather than
 * from a second, hand-built one that could drift from it.
 */
export type EmailCaptureResult =
  | { ok: true }
  | { ok: false; message: string };

export interface AcquisitionCapability {
  /**
   * Resolves the session a request's cookie names, or issues a new one.
   * The returned `sessionToken` is what the route writes back as a cookie —
   * the only place a token legitimately leaves the server.
   */
  resolveOrCreateSession(
    sessionToken: string | null,
  ): Promise<AcquisitionSession>;
  getSessionByToken(sessionToken: string | null): Promise<AcquisitionSession | null>;
  /**
   * The project's own durable authority. `null` for a legacy project
   * created before acquisition sessions existed.
   */
  getSessionForProject(projectId: string): Promise<AcquisitionSession | null>;

  /**
   * THE GENERATION GATE. Called immediately before a `GenerationJob` would
   * be created, on every generation path there is.
   *
   * Never mutates anything when it refuses, so a refused request costs the
   * customer nothing.
   */
  authorizeConceptGeneration(
    projectId: string,
  ): Promise<ConceptGenerationAuthorization>;
  /**
   * Records the durable job that consumed a free concept. Called ONLY after
   * `createGenerationJob` has succeeded — see the ALLOCATION vs CONSUMPTION
   * note above for why the ordering is load-bearing.
   */
  recordFreeConceptConsumed(
    sessionId: string,
    generationJobId: string,
  ): Promise<void>;

  /**
   * THE FINALIZATION GATE. Print-ready preparation can dispatch paid
   * production reconstruction (Topaz), so until payment entitlement exists
   * it is available to internal and legacy-unbound projects only.
   */
  authorizeFinalization(projectId: string): Promise<FinalizationAuthorization>;

  /**
   * THE EMAIL GATE. Whether a further design turn may proceed. Refuses only
   * once the free concept has actually been delivered — a prospect whose
   * concept is still generating is not asked for anything.
   *
   * Sprint A4 Correction C2: takes no `conceptDelivered` argument. It used
   * to, and the caller computed it as `artworkVersions.length > 0` — a
   * second, staler copy of a rule this capability already owns. Delivery is
   * now resolved here, from the SESSION, for every surface alike.
   */
  authorizeSessionContinuation(
    projectId: string,
  ): Promise<{ allowed: true } | { allowed: false; customerMessage: string }>;

  captureEmail(projectId: string, rawEmail: unknown): Promise<EmailCaptureResult>;

  /** Grants the internal entitlement. Authorization happens in the route, never here. */
  grantInternalEntitlement(sessionId: string): Promise<AcquisitionSession | null>;

  /**
   * The customer-safe view attached to every project snapshot.
   *
   * Sprint A4 Correction C2: `conceptDelivered` is likewise no longer an
   * input. `generating` remains one because it is genuinely a property of
   * the project being READ ("is this project busy right now"), not of the
   * session's entitlement.
   */
  describeForCustomer(
    projectId: string,
    input: { generating: boolean },
  ): Promise<CustomerAcquisitionView>;
}

/**
 * 32 bytes of CSPRNG output, base64url. Not a UUID: a v4 UUID carries 122
 * bits and a recognizable shape, and this value is a bearer credential
 * rather than a database key — the extra entropy is free and the
 * unstructured shape gives an attacker nothing to pattern-match.
 */
function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createAcquisitionCapability(
  repo: ProjectRepository,
): AcquisitionCapability {
  /**
   * The one place "what is this project's acquisition authority?" is
   * answered.
   *
   * Sprint A4 Correction 1: this used to return `AcquisitionSession | null`,
   * and that shape was the defect. `null` meant BOTH "legacy project,
   * grandfathered" and "bound to a session I could not load", so a missing,
   * deleted, or unreadable session silently granted unrestricted generation
   * and finalization — losing a row handed out spend. The two cases are now
   * distinct values and only one of them is permissive.
   *
   * A repository error is also `"unavailable"` rather than a thrown
   * exception: every caller here has a correct, safe behavior for "I cannot
   * establish authority" (refuse), and turning an infrastructure blip into a
   * 500 on a customer request buys nothing that failing closed does not.
   */
  async function resolveAuthority(projectId: string): Promise<ResolvedAuthority> {
    let sessionId: string | null;
    try {
      const snapshot = await repo.getProject(projectId);
      // No project at all. Callers that need one fail on their own terms
      // (`Project not found`); there is no authority to speak of here, and
      // treating it as legacy would be inventing one.
      if (!snapshot) return { kind: "unavailable" };
      sessionId = snapshot.project.acquisitionSessionId;
    } catch {
      return { kind: "unavailable" };
    }

    // The ONLY permissive `null`: a project created before acquisition
    // sessions existed. After A4 every project created through the customer
    // API is bound in the same INSERT that creates it, and the database now
    // refuses to delete a session that projects reference (ON DELETE
    // RESTRICT), so this value can no longer be manufactured.
    if (!sessionId) return { kind: "legacy" };

    try {
      const session = await repo.getAcquisitionSession(sessionId);
      if (!session) return { kind: "unavailable" };
      return { kind: "session", session };
    } catch {
      return { kind: "unavailable" };
    }
  }

  /**
   * A session that is not subject to the acquisition funnel at all.
   * Internal grants are the only such tier today.
   */
  function isUnrestricted(session: AcquisitionSession): boolean {
    return session.entitlement === "internal";
  }

  /**
   * Has this session spent its free concept?
   *
   * Sprint A4 Correction 2: the FIRST source consulted is now the durable
   * claim, because that is the thing the database actually enforces at job
   * insert. Deriving application state from anything else risks the failure
   * mode Goal 15 names directly — the database refusing an insert the
   * application had just told the customer was available, or the reverse.
   *
   * Three sources, any one sufficient, in decreasing order of authority:
   *
   *   the free-concept claim  the session-owned tombstone. Survives deletion
   *                           of the job, and is what the insert is actually
   *                           checked against.
   *   freeConceptConsumedAt   the marker written after the job insert. Kept
   *                           for customer state and audit ("when"), not as
   *                           authority.
   *   the free-concept job    still meaningful while it exists; retained as
   *                           a third, independent reading rather than
   *                           removed.
   *
   * Every read failure is treated as CONSUMED. The safe direction for an
   * entitlement question is always the one that does not spend money, and a
   * database that cannot be read is not a database that has said yes.
   */
  async function freeConceptSpent(session: AcquisitionSession): Promise<boolean> {
    try {
      if ((await repo.getFreeConceptClaim(session.id)) !== null) return true;
    } catch {
      return true;
    }
    if (session.freeConceptConsumedAt) return true;
    if (session.freeConceptGenerationJobId) return true;
    try {
      return (await repo.getFreeConceptGenerationJob(session.id)) !== null;
    } catch {
      return true;
    }
  }

  /**
   * Sprint A4 Correction 3: has this session's free attempt actually put a
   * request in front of a provider?
   *
   * Read from `paid_image_intents.dispatches`, which is incremented by the
   * conditional write that AUTHORIZES a dispatch — immediately before the
   * external request and never after. So a non-zero count means "a request
   * may have reached the provider", and zero means the attempt was stopped
   * on our side of the boundary with nothing spent.
   *
   * Used ONLY to describe customer state, never to authorize spend: the
   * generation gate is the claim plus the dispatch ceiling, and neither
   * consults this. Its only job is to stop the UI telling a customer their
   * free concept is gone when it is not.
   *
   * Fails CLOSED (reports dispatched) — the conservative direction here is
   * the one that does not promise the customer an attempt they may not have.
   */
  async function freeAttemptDispatched(
    session: AcquisitionSession,
  ): Promise<boolean> {
    try {
      const job = await repo.getFreeConceptGenerationJob(session.id);
      if (!job) return true;
      const intents = await repo.listPaidImageIntentsForJob(job.projectId, job.id);
      return intents.some((intent) => intent.dispatches > 0);
    } catch {
      return true;
    }
  }

  /**
   * Sprint A4 Correction C2: THE ONE ANSWER to "has this SESSION actually
   * received the free concept it was promised?"
   *
   * WHY IT IS SESSION-LEVEL
   *
   * Correction C established what a delivered concept is
   * (`hasDeliveredGeneratedConcept`) and wired it into exactly one consumer,
   * the customer state view, from the project being read. That was too
   * narrow in the one dimension that mattered: the entitlement belongs to
   * the SESSION, not to a project. A prospect who starts a second design in
   * the same browser is refused on project B for something that happened on
   * project A, and project B's own snapshot contains no evidence of
   * anything — no job, no artwork, no messages.
   *
   * The live consequence: the second project's card correctly read
   * `continue_locked` while its TRANSCRIPT asked for an email, because the
   * refusal path decided from `!session.email` alone and never asked
   * whether a concept had been delivered at all. The customer was asked to
   * pay with their address for something they had never been shown.
   *
   * So the question is asked of the session's free-concept PROJECT, through
   * the same shared rule every other surface uses. Two existing authorities
   * name that project, in decreasing directness:
   *
   *   freeConceptProjectId   the allocation, written atomically before any
   *                          job exists.
   *   the free-concept job   the reconciliation source, which survives a
   *                          lost allocation marker (same fallback
   *                          `freeConceptSpent` relies on).
   *
   * FAILS CLOSED FOR ASKING. Every unreadable case answers "not delivered",
   * which can only ever SUPPRESS an email request — never grant spend, and
   * never restore an entitlement. `freeConceptSpent` remains the sole
   * authority for whether the free concept is gone, and it fails closed in
   * the opposite direction, which is the correct direction for money.
   */
  async function freeConceptDelivered(
    session: AcquisitionSession,
  ): Promise<boolean> {
    let projectId = session.freeConceptProjectId;
    if (!projectId) {
      try {
        const job = await repo.getFreeConceptGenerationJob(session.id);
        projectId = job?.projectId ?? null;
      } catch {
        return false;
      }
    }
    if (!projectId) return false;

    try {
      const snapshot = await repo.getProject(projectId);
      if (!snapshot) return false;
      // The SAME rule the concept grid renders against — never a second
      // definition of "delivered" (see `shared/concept-delivery.ts`).
      return hasDeliveredGeneratedConcept({
        status: snapshot.project.status,
        artworkVersions: snapshot.artworkVersions,
        messages: snapshot.messages,
      });
    } catch {
      return false;
    }
  }

  /**
   * The refusals for a session whose free concept is gone are genuinely
   * different product states, and the customer is told the true one.
   *
   * Sprint A4 Correction C2: there are THREE of them, not two. Asking for
   * an address is only honest once the free concept has actually been
   * delivered — an address unlocks continuing to work on a design the
   * customer can see, and there is nothing to continue for somebody who was
   * never shown one. A spent-but-undelivered session is told plainly that
   * the free path is over, in the same sentence
   * (`FREE_CONCEPT_SPENT_MESSAGE`) its customer state view already uses, so
   * the transcript and the card cannot say different things.
   */
  async function refuseSpentFreeConcept(
    session: AcquisitionSession,
  ): Promise<ConceptGenerationAuthorization> {
    if (session.email) {
      return {
        allowed: false,
        reason: "paid_access_required",
        customerMessage: PAID_GENERATION_LOCKED_MESSAGE,
      };
    }
    if (await freeConceptDelivered(session)) {
      return {
        allowed: false,
        reason: "email_required",
        customerMessage: EMAIL_REQUIRED_CONVERSATION_MESSAGE,
      };
    }
    return {
      allowed: false,
      reason: "paid_access_required",
      customerMessage: FREE_CONCEPT_SPENT_MESSAGE,
    };
  }

  return {
    async resolveOrCreateSession(sessionToken) {
      if (sessionToken) {
        const existing = await repo.getAcquisitionSessionByToken(sessionToken);
        // An unrecognized token is treated as no token rather than as an
        // error: it is the ordinary outcome of a database reset, an expired
        // row, or a cookie from another deployment, and a customer must
        // never be shown a failure for it.
        if (existing) return existing;
      }
      return repo.createAcquisitionSession(newSessionToken());
    },

    async getSessionByToken(sessionToken) {
      if (!sessionToken) return null;
      return repo.getAcquisitionSessionByToken(sessionToken);
    },

    async getSessionForProject(projectId) {
      const authority = await resolveAuthority(projectId);
      return authority.kind === "session" ? authority.session : null;
    },

    async authorizeConceptGeneration(projectId) {
      const authority = await resolveAuthority(projectId);

      // Authority could not be established. Refused — never grandfathered.
      if (authority.kind === "unavailable") {
        return {
          allowed: false,
          reason: "authority_unavailable",
          customerMessage: ACQUISITION_UNAVAILABLE_MESSAGE,
        };
      }

      // Legacy project (created before acquisition sessions existed) —
      // grandfathered. This is not a hole: after A4 every project created
      // through the customer API is bound at insert, and the database now
      // refuses to delete a session that projects reference, so a `null`
      // binding can no longer be manufactured.
      if (authority.kind === "legacy") {
        return { allowed: true, grant: "entitled", sessionId: null };
      }

      const { session } = authority;
      if (isUnrestricted(session)) {
        return { allowed: true, grant: "entitled", sessionId: null };
      }

      // Sprint A4 Correction 1: checked BEFORE allocation, and independently
      // of it. A crash between the job insert and the consumption marker
      // leaves the allocation intact and the marker unwritten, which the
      // allocation call alone would report as a resumable free concept.
      if (await freeConceptSpent(session)) {
        return await refuseSpentFreeConcept(session);
      }

      const allocation = await repo.allocateFreeConcept(session.id, projectId);
      if (allocation.outcome === "exhausted") {
        return await refuseSpentFreeConcept(allocation.session);
      }

      // "allocated" (first request) and "resumed" (reload, second tab,
      // duplicate request, retry after a failed enqueue) are the same
      // authorization: this project holds the free concept and nothing
      // durable has consumed it yet.
      return { allowed: true, grant: "free_concept", sessionId: session.id };
    },

    async recordFreeConceptConsumed(sessionId, generationJobId) {
      // Sprint A4 Correction 1: this is now a DENORMALIZED MARKER, not the
      // authority. The authority is the free-concept job itself, which the
      // database guarantees is unique per session — so a failure here can no
      // longer produce a second free concept, and must not be allowed to
      // fail a request whose job is already durable and queued.
      //
      // Swallowed rather than propagated for exactly that reason: the
      // customer's concept is real and on its way, and `freeConceptSpent`
      // reconciles the missing marker from the job on the next read. Logged
      // so the gap is visible rather than silent.
      try {
        await repo.recordFreeConceptConsumed(sessionId, generationJobId);
      } catch (error) {
        console.error(
          "Failed to record free-concept consumption marker; authority is reconciled from the generation job",
          { acquisitionSessionId: sessionId, generationJobId, error },
        );
      }
    },

    async authorizeFinalization(projectId) {
      const authority = await resolveAuthority(projectId);
      if (authority.kind === "unavailable") {
        return { allowed: false, customerMessage: ACQUISITION_UNAVAILABLE_MESSAGE };
      }
      if (authority.kind === "legacy") return { allowed: true };
      if (isUnrestricted(authority.session)) return { allowed: true };
      // No paid entitlement exists in A4, so for every prospect this is a
      // refusal. Deliberately not conditioned on whether the free concept
      // was used: print-ready preparation can dispatch paid production
      // reconstruction, and it is not part of what the free concept
      // demonstrates.
      return { allowed: false, customerMessage: PAID_FINALIZATION_LOCKED_MESSAGE };
    },

    async authorizeSessionContinuation(projectId) {
      const authority = await resolveAuthority(projectId);
      if (authority.kind === "unavailable") {
        return { allowed: false, customerMessage: ACQUISITION_UNAVAILABLE_MESSAGE };
      }
      if (authority.kind === "legacy") return { allowed: true };

      const { session } = authority;
      if (isUnrestricted(session)) return { allowed: true };
      if (session.email) return { allowed: true };
      // Nothing has been demonstrated yet — asking for an address here
      // would be a toll booth before the value, which is not the funnel.
      // Reconciled rather than read off the marker alone, so a lost
      // consumption write cannot leave the gate permanently open.
      if (!(await freeConceptSpent(session))) return { allowed: true };
      // Sprint A4 Correction C2: resolved HERE, from the session, rather
      // than trusted from the caller. `ConversationCapability` used to pass
      // `artworkVersions.length > 0` — the pre-Correction-C rule, which
      // counted a `prepared_upload` row on an Existing Artwork project as a
      // delivered free concept and refused the customer's message because
      // of it.
      if (!(await freeConceptDelivered(session))) return { allowed: true };

      return {
        allowed: false,
        customerMessage: EMAIL_REQUIRED_CONVERSATION_MESSAGE,
      };
    },

    async captureEmail(projectId, rawEmail) {
      const validation = validateEmail(rawEmail);
      if (!validation.valid) {
        return { ok: false, message: validation.message };
      }

      const authority = await resolveAuthority(projectId);
      if (authority.kind !== "session") {
        // A legacy project has no session to attach an address to, and an
        // unavailable one must not be guessed at. Refused rather than
        // silently discarded — a customer told "saved" about something that
        // was not saved is worse than a plain refusal.
        return {
          ok: false,
          message: "We couldn't save that right now. Please try again.",
        };
      }

      const updated = await repo.captureAcquisitionEmail(authority.session.id, {
        email: validation.email,
      });
      if (!updated) {
        return {
          ok: false,
          message: "We couldn't save that right now. Please try again.",
        };
      }

      // Capturing an address grants nothing. The free concept stays spent
      // and paid generation stays locked — this is product progression, not
      // an entitlement (Goal 14).
      return { ok: true };
    },

    async grantInternalEntitlement(sessionId) {
      return repo.grantInternalEntitlement(sessionId);
    },

    async describeForCustomer(projectId, input) {
      const authority = await resolveAuthority(projectId);
      // Sprint A4 Correction 1: authority could not be established, so the
      // customer is shown a neutral unavailable state rather than `"open"`.
      // `"open"` is a promise that the next action will work, and the server
      // is about to refuse it — showing it would put the UI and the gates
      // into open disagreement.
      if (authority.kind === "unavailable") {
        return {
          state: "unavailable",
          message: ACQUISITION_UNAVAILABLE_MESSAGE,
          emailCaptured: false,
        };
      }
      // A legacy or internal session is indistinguishable from "nothing is
      // gated" on purpose — the customer surface must not be able to tell
      // that an internal tier exists.
      if (authority.kind === "legacy" || isUnrestricted(authority.session)) {
        return { state: "open", message: null, emailCaptured: false };
      }

      const { session } = authority;
      const emailCaptured = session.email !== null;
      // Reconciled, not read off the marker — the state a customer is shown
      // must agree with what the gates will actually do, including in the
      // crash window where the marker was never written.
      const freeConceptConsumed = await freeConceptSpent(session);
      // Sprint A4 Correction C2: the SAME session-level answer the two
      // transcript refusals now use. Previously the caller supplied this
      // from the project being read, which made the card and the transcript
      // disagree for every project that is not the one the free concept was
      // spent on.
      const conceptDelivered = await freeConceptDelivered(session);

      if (!freeConceptConsumed) {
        return { state: "open", message: null, emailCaptured };
      }
      if (input.generating && !conceptDelivered) {
        return {
          state: "free_concept_generating",
          message: null,
          emailCaptured,
        };
      }
      // Nothing generating, nothing delivered: the attempt is over without
      // producing artwork. WHY it is over decides what the customer is told,
      // and the two answers are genuinely different.
      if (!conceptDelivered) {
        // Sprint A4 Correction 3: if no physical dispatch was ever made, the
        // attempt was stopped by OUR local configuration before anything
        // reached a provider. Nothing was spent, the same authorized job is
        // still retryable, and pressing the button again will work — so
        // `continue_locked` would be a lie that strands a customer whose
        // free concept is entirely intact.
        if (!(await freeAttemptDispatched(session))) {
          return { state: "open", message: null, emailCaptured };
        }

        // Sprint A4 Correction 2: a real submission happened and produced
        // nothing (an ambiguous failure, or a removed job). That genuinely
        // ends the free path.
        //
        // This used to return `open` unconditionally, which is the same
        // defect as the old catch-to-open in a different place: the gate
        // will refuse, so telling the customer nothing is gated puts the UI
        // and the server into open disagreement.
        //
        // `email_required` would be the wrong ask either way — they never
        // saw a concept, so there is nothing an address would unlock.
        return {
          state: "continue_locked",
          message: emailCaptured
            ? PAID_GENERATION_LOCKED_MESSAGE
            : FREE_CONCEPT_SPENT_MESSAGE,
          emailCaptured,
        };
      }
      if (!emailCaptured) {
        return {
          state: "email_required",
          message: EMAIL_REQUIRED_CONVERSATION_MESSAGE,
          emailCaptured: false,
        };
      }
      return {
        state: "continue_locked",
        message: PAID_GENERATION_LOCKED_MESSAGE,
        emailCaptured: true,
      };
    },
  };
}
