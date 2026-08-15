/**
 * Sprint A4: every customer-facing string the acquisition gate can produce,
 * in one place — the same reason `shared/waiting-copy.ts` exists.
 *
 * THE RULE THESE ALL FOLLOW
 *
 * A customer is told what they can do next. They are never told how the
 * platform accounts for it. So none of this copy mentions credits, tokens,
 * quotas, entitlements, sessions, spend, provider cost, generation jobs,
 * abuse prevention, or anything else that is our bookkeeping rather than
 * their decision. "Free" is stated once, at the point it is useful (the
 * customer is being asked for something in return); it is never used to
 * meter, warn, or bargain.
 *
 * These are also deliberately NOT phrased as errors. A prospect who has
 * reached the email gate has not done anything wrong — they have reached
 * the end of what this product currently gives away, which is a normal
 * place to be.
 */

/**
 * Shown once the free concept exists and the design session cannot
 * continue without an address. Warm, specific about what happens next, and
 * silent about everything else.
 */
export const EMAIL_REQUIRED_HEADLINE =
  "Like where this is going?";
export const EMAIL_REQUIRED_MESSAGE =
  "Enter your email to keep working on your design.";

/**
 * The privacy sentence shown beside the input. Load-bearing, not
 * decoration: capturing an address for product progression and enrolling
 * someone in marketing are different things, and the customer is told which
 * one this is (Constitution §17, Goal 8). It also does not claim an account
 * has been created, because none has.
 */
export const EMAIL_PURPOSE_NOTE =
  "We use your email to continue your design session. No account is created, and we won't add you to a mailing list.";

export const EMAIL_SUBMIT_LABEL = "Continue";

/**
 * The assistant message posted when a further design turn is refused
 * because no address has been given yet. Says the same thing the gate card
 * says, so a customer reading only the transcript is not confused.
 */
export const EMAIL_REQUIRED_CONVERSATION_MESSAGE = `${EMAIL_REQUIRED_HEADLINE} ${EMAIL_REQUIRED_MESSAGE}`;

/**
 * Refusal copy for any further concept-generation request once the free
 * concept has been used and an address is already on file.
 *
 * States plainly that this is not available yet, and does NOT promise a
 * date, a price, or a plan — none of which exists. Sprint A5 owns payment;
 * writing "upgrade now" here would be copy for a product that is not built.
 */
export const PAID_GENERATION_LOCKED_MESSAGE =
  "You've used your free concept. New concepts and design changes aren't available on your session yet — we'll let you know at the email you gave us as soon as they are.";

/**
 * Sprint A4 Correction 2: the free attempt was spent and produced nothing —
 * it failed, or its job was removed.
 *
 * A separate sentence from `PAID_GENERATION_LOCKED_MESSAGE` because that one
 * promises "we'll let you know at the email you gave us", which is not true
 * of somebody who never reached the email gate (they never saw a concept to
 * be asked about). Saying it anyway would reference an address they never
 * gave.
 *
 * Deliberately does not invite a retry. The entitlement is one attempt, and
 * offering a button that the server will refuse is worse than saying plainly
 * that this is where the free path ends.
 */
export const FREE_CONCEPT_SPENT_MESSAGE =
  "You've used your free concept. New concepts aren't available on your session yet.";

/**
 * Refusal copy for print-ready production preparation. Deliberately
 * different from the generation message: producing the final file is a
 * different customer intention ("give me the artwork") and a customer who
 * is told the generic generation message here would reasonably think their
 * design was the problem.
 */
export const PAID_FINALIZATION_LOCKED_MESSAGE =
  "Preparing print-ready artwork isn't available on your session yet.";

/**
 * Sprint A4 Correction 1: shown when the server cannot currently establish
 * what this session is allowed to do — a project bound to a session that
 * cannot be loaded, or a repository failure while resolving authority.
 *
 * Deliberately says nothing about why. The customer does not benefit from
 * "your acquisition session row is missing", and an attacker probing for the
 * difference between "gated", "not found", and "broken" learns nothing from
 * one uniform sentence. It is phrased as a transient condition because that
 * is the honest expectation: nothing about their design has been lost.
 */
export const ACQUISITION_UNAVAILABLE_MESSAGE =
  "We can't continue this design session right now. Please try again in a moment.";

/**
 * Waiting copy for the ONE free concept. The three-direction messages in
 * `shared/waiting-copy.ts` cannot be reused here — promising "three concept
 * directions" and producing one is exactly the kind of thing that reads as
 * a bug rather than a plan.
 */
export const FREE_CONCEPT_WAITING_MESSAGE =
  "Design brief approved — creating your first concept. Thanks for your patience; this usually takes about 3–4 minutes.";
