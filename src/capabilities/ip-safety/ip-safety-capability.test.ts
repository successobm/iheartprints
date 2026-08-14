import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createIpSafetyCapability } from "./ip-safety-capability";
import {
  describeIpSafetyDecisionForCustomer,
  IP_SAFETY_REDIRECT_MESSAGE,
} from "./customer-response";
import type { IpSafetyReason, IpSafetySignal } from "./contracts";

/**
 * Sprint A3 — the IP / trademark safety boundary, at the decision level.
 *
 * Two properties matter more than any individual case here:
 *
 *   1. Protected-brand VOCABULARY alone never blocks. Every allow-case below
 *      contains a real brand, team, or league name and is still allowed,
 *      because discussion, negation, avoidance, removal, and ownership are
 *      not reproduction requests.
 *   2. The behavior is GENERAL. The structural cases (a reproduction verb, a
 *      mark noun bound to an owner, an exactness cue, evasion vocabulary)
 *      carry marks that appear nowhere in this codebase's vocabulary, and
 *      the evasion suite blocks with no brand named at all.
 */

const ip = createIpSafetyCapability();

function outcomeOf(message: string) {
  return ip.evaluateCustomerRequest({ message }).outcome;
}

function reasonsOf(message: string): IpSafetyReason[] {
  return ip.evaluateCustomerRequest({ message }).reasons;
}

/** Replays a conversation turn by turn and returns the LAST turn's outcome. */
function outcomeOfConversation(turns: string[]) {
  const messages: Array<{ role: string; content: string }> = [];
  let outcome: "allow" | "block" = "allow";
  for (const turn of turns) {
    outcome = ip.evaluateCustomerRequest({ message: turn, messages }).outcome;
    messages.push({ role: "user", content: turn });
    messages.push({
      role: "assistant",
      content:
        outcome === "block" ? IP_SAFETY_REDIRECT_MESSAGE : "Got it — anything else?",
    });
  }
  return outcome;
}

describe("IpSafetyCapability — requests that must be blocked", () => {
  /** A. Direct logo reproduction. */
  const directReproduction = [
    "Make me the Raiders logo.",
    "Recreate the Raiders shield.",
    "Use the Nike swoosh.",
    "Copy the Lakers logo.",
    "Recreate this NFL team's logo.",
    "Can you put the NBA logo on the front?",
    "I want the trademarked emblem reproduced on the back.",
    "now put the Raiders logo on it",
  ];
  for (const message of directReproduction) {
    it(`A: blocks direct reproduction — "${message}"`, () => {
      assert.equal(outcomeOf(message), "block");
    });
  }

  /** B. Recognizable imitation, with nothing named as a copy. */
  const imitation = [
    "Use this image and make the logo exactly the same.",
    "Make something almost identical to the Supreme logo.",
    "Make the badge look exactly like the one on their jerseys' logo.",
    "I want a crest that's indistinguishable from the original mark.",
  ];
  for (const message of imitation) {
    it(`B: blocks recognizable imitation — "${message}"`, () => {
      assert.equal(outcomeOf(message), "block");
    });
  }

  /**
   * C. Explicit evasion. Deliberately includes cases with NO brand named at
   * all — asking for a knockoff is an evasion request on its own terms.
   */
  const evasion = [
    "Make a Raiders logo but change it enough so it's legal.",
    "Change the Raiders logo 10% so I can sell it.",
    "Make the Nike swoosh different enough to avoid copyright.",
    "Remove the trademark symbol.",
    "Remove the trademark symbol from this logo.",
    "Make it almost identical but technically different.",
    "Copy this logo without making it obvious.",
    "Make a knockoff version.",
    "Make something almost identical so we don't get in trouble.",
    "Change the Raiders logo just enough that it's legal.",
    "Give me a bootleg version of that shirt.",
    "Take off the ® and print it like that.",
  ];
  for (const message of evasion) {
    it(`C: blocks evasion — "${message}"`, () => {
      assert.equal(outcomeOf(message), "block");
    });
  }

  it("C: an evasion request is classified as evasion internally", () => {
    assert.ok(
      reasonsOf("Make a knockoff version.").includes("protection_evasion_request"),
    );
  });

  it("C: the product never states a threshold or an acceptable amount of change", () => {
    const response = describeIpSafetyDecisionForCustomer(
      ip.evaluateCustomerRequest({
        message: "Change the Raiders logo 10% so I can sell it.",
      }),
    );
    assert.ok(response);
    assert.doesNotMatch(response, /\d+\s*%|percent|different enough|just enough/i);
  });

  /** D. Protected characters. */
  const characters = [
    "Make Mickey Mouse wearing a football jersey.",
    "Use Disney's Mickey Mouse.",
    "Put SpongeBob on the front of the shirt.",
    "I want Darth Vader holding a bowling ball.",
  ];
  for (const message of characters) {
    it(`D: blocks protected-character reproduction — "${message}"`, () => {
      assert.equal(outcomeOf(message), "block");
    });
  }
});

describe("IpSafetyCapability — ordinary design work that must stay allowed", () => {
  /** E. Generic themed design — the whole point of the product. */
  const genericThemes = [
    "Make a black and silver football design.",
    "Create a pirate-themed football shirt.",
    "Create a Las Vegas football design.",
    "Make an aggressive pirate skull with crossed swords.",
    "Create a purple and gold basketball design.",
    "Make a vintage Los Angeles basketball shirt.",
    "Create a generic athletic motion mark.",
    "Add an athletic swoosh-like motion as a generic visual concept.",
    "Make bold collegiate lettering.",
  ];
  for (const message of genericThemes) {
    it(`E: allows a generic theme — "${message}"`, () => {
      assert.equal(outcomeOf(message), "allow");
    });
  }

  /** F. Brand discussion without any request to reproduce. */
  const discussion = [
    "My company is doing a watch party for the Raiders.",
    "I like black and silver.",
    "We're Nike fans but that's not what this is for.",
    "The shirts are for an NFL tailgate we're hosting.",
  ];
  for (const message of discussion) {
    it(`F: allows brand discussion — "${message}"`, () => {
      assert.equal(outcomeOf(message), "allow");
    });
  }

  /** G. Explicit negation. */
  const negation = [
    "Don't use the Raiders logo.",
    "No team logos, please.",
    "Do not put the Nike swoosh anywhere on this.",
  ];
  for (const message of negation) {
    it(`G: allows explicit negation — "${message}"`, () => {
      assert.equal(outcomeOf(message), "allow");
    });
  }

  /** H. Avoidance — "make it original, not like X". */
  const avoidance = [
    "Make this NOT look like the Raiders.",
    "The customer said Raiders, but we want something completely original.",
    "Something in the spirit of a pirate team, but original.",
  ];
  for (const message of avoidance) {
    it(`H: allows avoidance — "${message}"`, () => {
      assert.equal(outcomeOf(message), "allow");
    });
  }

  /** I. Removal — the requested result is unbranded artwork. */
  const removal = [
    "Remove the Nike logo from the reference.",
    "Take the team logo off and leave the rest.",
    "Get rid of the brand mark in the corner.",
  ];
  for (const message of removal) {
    it(`I: allows logo removal — "${message}"`, () => {
      assert.equal(outcomeOf(message), "allow");
    });
  }

  /** The interview helper's own answers must never trip the boundary. */
  const ordinaryInterviewAnswers = [
    "Camp shirts",
    "A friendly bear logo",
    "Navy",
    "Camp Wildwood 2026",
    "You choose.",
    "Actually, make it a hoodie.",
    "Make the bear bigger and move the wording under it.",
  ];
  for (const message of ordinaryInterviewAnswers) {
    it(`allows an ordinary interview answer — "${message}"`, () => {
      assert.equal(outcomeOf(message), "allow");
    });
  }
});

/**
 * CORRECTION 1 — the operator must govern what it actually modifies.
 *
 * The original detector cleared an entire punctuation-delimited clause the
 * moment a disqualifying word appeared anywhere in it, so an unrelated
 * trailing instruction silently unblocked an explicit reproduction request.
 * Both directions are pinned here; neither may regress without the other
 * noticing.
 */
describe("Correction 1 — a disqualifier only clears what it governs", () => {
  const stillBlocked = [
    "Make me the Raiders logo, no text.",
    "Make me a Raiders logo and don't add anything else.",
    "Use the Nike swoosh, no words.",
    "Don't copy it exactly, just make it nearly identical.",
    "Raiders themed, including their shield.",
    "Same vibe as the Raiders logo.",
    "Make the Lakers logo, nothing else on the shirt.",
    "Recreate the Raiders shield and don't change the colors.",
  ];
  for (const message of stillBlocked) {
    it(`blocks — the disqualifier governs something else: "${message}"`, () => {
      assert.equal(outcomeOf(message), "block");
    });
  }

  const stillAllowed = [
    "Don't use the Raiders logo.",
    "Remove the Nike logo.",
    "Remove the Nike logo from the reference.",
    "Make this nothing like the Raiders.",
    "I like the Raiders colors but make everything original.",
    "The customer said Raiders, but we want something completely original.",
    "Make this NOT look like the Raiders.",
    "No team logos, please.",
    "Do not put the Nike swoosh anywhere on this.",
    "Take the team logo off and leave the rest.",
    "Get rid of the brand mark in the corner.",
    "Don't make a knockoff of anything.",
  ];
  for (const message of stillAllowed) {
    it(`allows — the disqualifier genuinely governs the referent: "${message}"`, () => {
      assert.equal(outcomeOf(message), "allow");
    });
  }
});

/**
 * P1 — a customer may legitimately run "Raiders Plumbing LLC". A recognized
 * token followed by a trade or legal-entity noun is a business NAME, and
 * that occurrence is not a protected referent. Occurrence-level, so the
 * protection survives everywhere else in the same sentence.
 *
 * This is a reading of sentence structure, not an ownership or rights
 * determination.
 */
describe("P1 — business names containing a recognized token", () => {
  const businessNames = [
    "Raiders Plumbing LLC needs a new logo.",
    "Raiders Electric needs a logo for their trucks.",
    "Supreme Plumbing wants a new logo.",
    "Mickey Mouse Plumbing needs a logo.",
    "Make a logo for Raiders Roofing Inc.",
  ];
  for (const message of businessNames) {
    it(`allows a customer business name — "${message}"`, () => {
      assert.equal(outcomeOf(message), "allow");
    });
  }

  const stillProtected = [
    "Make the Raiders logo.",
    "Make me the Raiders logo.",
    "Use the Supreme logo.",
  ];
  for (const message of stillProtected) {
    it(`still blocks the mark itself — "${message}"`, () => {
      assert.equal(outcomeOf(message), "block");
    });
  }

  it("neutralizes only the colliding occurrence, not the whole sentence", () => {
    assert.equal(
      outcomeOf("Raiders Plumbing wants the Raiders logo on their shirts."),
      "block",
    );
  });
});

/**
 * P1 — an ownership phrase never overrides a recognized third-party
 * referent. iHeartPrints does not verify either claim, and honouring the
 * unrecognized one is a usability decision, not a finding of ownership.
 */
describe("P1 — ownership cannot rescue recognized third-party IP", () => {
  const blocked = [
    "Recreate our Raiders logo.",
    "Our Nike swoosh needs to be bigger.",
    "Use our Lakers logo.",
    "Our company owns the Mickey Mouse character; recreate it.",
    "We own this NFL logo; reproduce it.",
  ];
  for (const message of blocked) {
    it(`blocks — "${message}"`, () => {
      assert.equal(outcomeOf(message), "block");
    });
  }

  const allowed = [
    "Recreate our Rivera Plumbing logo.",
    "Make our ABC Roofing logo larger.",
    "Recreate our logo.",
    "Make our trademarked logo bigger.",
    "This is my company's mark — clean it up and center it.",
    "Make my logo exactly the same but bigger.",
  ];
  for (const message of allowed) {
    it(`allows unknown customer branding — "${message}"`, () => {
      assert.equal(outcomeOf(message), "allow");
    });
  }
});

/** P1 — realistic high-confidence imitation and evasion phrasing. */
describe("P1 — realistic imitation and evasion language", () => {
  const blocked = [
    "Give it the Raiders logo look.",
    "Make it recognizably Raiders.",
    "Raiders logo inspired.",
    "Raiders themed, including their shield.",
    "Make it close enough that people know what it is.",
    "Make it 10% different.",
    "Don't copy it exactly, just make it nearly identical.",
    "Make a knockoff Raiders logo.",
    "Make the Nike swoosh slightly different.",
    "Copy it without making it obvious.",
  ];
  for (const message of blocked) {
    it(`blocks — "${message}"`, () => {
      assert.equal(outcomeOf(message), "block");
    });
  }

  it("cross-turn: a bare reference to 'their shield' resolves against the design context", () => {
    assert.equal(
      outcomeOfConversation(["I want a Raiders design.", "Use their shield shape and layout."]),
      "block",
    );
  });
});

/**
 * CORRECTION 3 — bounded multi-turn authority.
 *
 * A request split across turns is one request. The window is deliberately
 * small and excludes turns that were themselves refused, so a customer is
 * never punished for rephrasing and no project is permanently poisoned.
 */
describe("Correction 3 — bounded multi-turn composition", () => {
  it("blocks a request split across two turns", () => {
    assert.equal(
      outcomeOfConversation(["I want a Raiders design.", "Use their exact shield."]),
      "block",
    );
  });

  it("blocks a request split across three turns", () => {
    assert.equal(
      outcomeOfConversation([
        "Let's make a football design.",
        "Raiders.",
        "Use the logo.",
      ]),
      "block",
    );
  });

  it("does not invent a referent that was never mentioned", () => {
    assert.equal(
      outcomeOfConversation([
        "Let's make a football design.",
        "Pirate skull.",
        "Use the logo.",
      ]),
      "allow",
    );
  });

  it("unsafe → safe correction → allowed, on the same conversation", () => {
    assert.equal(
      outcomeOfConversation([
        "Make me the Raiders logo.",
        "Actually, make it a black and silver pirate skull instead.",
      ]),
      "allow",
    );
  });

  it("unsafe → safe → unsafe blocks again", () => {
    assert.equal(
      outcomeOfConversation([
        "Make me the Raiders logo.",
        "Actually, make it a black and silver pirate skull instead.",
        "Now put the Raiders logo on it.",
      ]),
      "block",
    );
  });

  it("a refused turn is not carried forward as context", () => {
    // Without the refused-turn exclusion, the blocked message would keep
    // re-blocking the customer's next two ordinary turns.
    assert.equal(
      outcomeOfConversation([
        "Make me the Raiders logo.",
        "Make it a pirate skull in black and silver.",
        "Make the logo bigger.",
      ]),
      "allow",
    );
  });
});

/**
 * CORRECTION 2 — one canonical subject, composed across every
 * generation-bearing structured field.
 */
describe("Correction 2 — compositional structured generation intent", () => {
  function evaluateIntent(
    fields: Partial<{
      designDescription: string;
      designStyle: string;
      additionalInstructions: string;
      exclusions: string;
      revisionInstruction: string;
    }>,
  ) {
    return ip.evaluateGenerationIntent({
      designDescription: fields.designDescription ?? null,
      designStyle: fields.designStyle ?? null,
      additionalInstructions: fields.additionalInstructions ?? null,
      exclusions: fields.exclusions ?? null,
      revisionInstruction: fields.revisionInstruction ?? null,
    });
  }

  it("associates a referent in one field with the instruction in another", () => {
    assert.equal(
      evaluateIntent({
        designDescription: "Raiders",
        additionalInstructions: "use the exact shield",
      }).outcome,
      "block",
    );
  });

  it("associates a referent in the description with an imitation cue in the style", () => {
    assert.equal(
      evaluateIntent({
        designDescription: "A pirate skull",
        designStyle: "exactly like the Raiders logo",
      }).outcome,
      "block",
    );
  });

  it("a safe corrective instruction governs the design context behind it", () => {
    assert.equal(
      evaluateIntent({
        designDescription: "Raiders themed football design",
        revisionInstruction: "remove the logo and make it original",
      }).outcome,
      "allow",
    );
  });

  it("reads design CONTENT as an instruction to draw — no imperative verb needed", () => {
    assert.equal(evaluateIntent({ designDescription: "The Raiders logo" }).outcome, "block");
  });

  it("leaves an ordinary brief alone", () => {
    assert.equal(
      evaluateIntent({ designDescription: "A friendly bear logo for a summer camp" }).outcome,
      "allow",
    );
    assert.equal(
      evaluateIntent({ designDescription: "Black and silver pirate football design" }).outcome,
      "allow",
    );
  });

  it("a negated brief note is not a reproduction request", () => {
    assert.equal(
      evaluateIntent({ designDescription: "Pirate skull. Don't use the Raiders logo." }).outcome,
      "allow",
    );
  });

  it("an exclusion naming a mark is an instruction to stay away from it", () => {
    assert.equal(
      evaluateIntent({
        designDescription: "Pirate skull in black and silver",
        exclusions: "no Raiders logo",
      }).outcome,
      "allow",
    );
  });

  it("a removal revision stays a removal; a reproduction revision does not", () => {
    assert.equal(
      evaluateIntent({
        designDescription: "A friendly bear logo",
        revisionInstruction: "Remove the Nike logo from it.",
      }).outcome,
      "allow",
    );
    assert.equal(
      evaluateIntent({
        designDescription: "A friendly bear logo",
        revisionInstruction: "Now make it the Raiders logo.",
      }).outcome,
      "block",
    );
  });

  it("is stable and derived — the same intent always decides the same way", () => {
    const first = evaluateIntent({ designDescription: "The Raiders logo" });
    const second = evaluateIntent({ designDescription: "The Raiders logo" });
    assert.deepEqual(first.reasons, second.reasons);
    // Nothing about the blocked evaluation survives into the next one.
    assert.equal(
      evaluateIntent({ designDescription: "A pirate skull in black and silver" }).outcome,
      "allow",
    );
  });
});

/**
 * P2 — SEMANTIC PRECEDENCE.
 *
 * The hint may EXTEND deterministic recall — it is the only way a mark
 * nobody enumerated gets caught — but it may never contradict safety the
 * customer wrote plainly, and it may never be required for enforcement.
 */
describe("P2 — semantic signal precedence", () => {
  const signal = (
    kind: IpSafetySignal["kind"],
    confidence: IpSafetySignal["confidence"],
    evidence: string,
  ): IpSafetySignal => ({ kind, confidence, evidence });

  it("extends recall: blocks a mark the deterministic layer does not know", () => {
    const message = "Make me the Fictitious Rovers club badge.";
    assert.equal(outcomeOf(message), "allow");
    assert.equal(
      ip.evaluateCustomerRequest({
        message,
        semanticSignal: signal(
          "protected_mark_reproduction",
          "explicit",
          "the Fictitious Rovers club badge",
        ),
      }).outcome,
      "block",
    );
  });

  it("a deterministic block cannot be overridden by a null or absent signal", () => {
    for (const semanticSignal of [null, undefined]) {
      assert.equal(
        ip.evaluateCustomerRequest({
          message: "Make me the Raiders logo.",
          semanticSignal,
        }).outcome,
        "block",
      );
    }
  });

  it("never blocks on an ambiguous signal", () => {
    assert.equal(
      ip.evaluateCustomerRequest({
        message: "Make a black and silver football design.",
        semanticSignal: signal(
          "protected_mark_reproduction",
          "ambiguous",
          "black and silver football design",
        ),
      }).outcome,
      "allow",
    );
  });

  /**
   * The core P2 correction: safe wording in the customer's own message
   * outranks any model hint about THAT SAME request. Negation, removal,
   * avoidance, and a claim over unrecognized branding are all written down
   * plainly — refusing them because a model guessed would be the worst kind
   * of false positive.
   *
   * Each case supplies the kind of short customer-text quote the
   * `IpSafetySignal` contract requires, because Correction 3 resolves
   * suppression positionally: the quote is how the enforcement layer knows
   * WHICH request the signal is about.
   */
  const explicitlySafe: Array<[message: string, evidence: string]> = [
    ["Don't use the Raiders logo.", "the Raiders logo"],
    ["Remove the Nike logo from the reference.", "the Nike logo"],
    ["Make this nothing like the Raiders.", "nothing like the Raiders"],
    ["Recreate our Rivera Plumbing logo.", "our Rivera Plumbing logo"],
  ];
  for (const [message, evidence] of explicitlySafe) {
    for (const confidence of ["inferred", "explicit"] as const) {
      it(`a ${confidence} signal cannot refuse the same request the customer already ruled out — "${message}"`, () => {
        assert.equal(
          ip.evaluateCustomerRequest({
            message,
            semanticSignal: signal(
              "protected_mark_reproduction",
              confidence,
              evidence,
            ),
          }).outcome,
          "allow",
        );
      });
    }
  }

  it("an inferred signal still may not fire where the customer negated the request", () => {
    assert.equal(
      ip.evaluateCustomerRequest({
        message: "Do not put the Nike swoosh anywhere on this.",
        semanticSignal: signal("protection_evasion", "inferred", "the Nike swoosh"),
      }).outcome,
      "allow",
    );
  });

  /**
   * Correction 3: suppression is positional, so a signal whose quote cannot
   * be located in the customer's own words cannot establish that the safe
   * wording covers it. On a spend boundary the unresolvable case refuses.
   */
  it("a signal with no locatable quote does not get the benefit of nearby safe wording", () => {
    assert.equal(
      ip.evaluateCustomerRequest({
        message: "Don't use the Raiders logo.",
        semanticSignal: signal("protected_mark_reproduction", "explicit", ""),
      }).outcome,
      "block",
    );
  });
});

/**
 * CORRECTION 2 — SEMANTIC SUPPRESSION IS SCOPED, NOT BLANKET.
 *
 * Safe evidence about one occurrence must never grant blanket immunity to a
 * different, surviving request. The audited defect:
 *
 *     "Don't use the old logo, recreate the Fictitious Rovers badge."
 *
 * The first half neutralizes a mark noun and legitimately sets
 * `safeStructure`. The second half is a reproduction request naming a mark
 * the deterministic backstop lexicon has never heard of — precisely the case
 * the semantic layer exists to cover. Suppressing the hint on the strength
 * of the first half handed that request to a paid provider.
 *
 * "Fictitious Rovers" and "Acme Falcons" are invented for these tests and
 * are deliberately NOT in the lexicon — that is the whole point. Adding them
 * would prove nothing.
 */
describe("Correction 2 — safe evidence only suppresses the request it explains", () => {
  const reproduction = (
    confidence: IpSafetySignal["confidence"],
    evidence = "recreate the Fictitious Rovers badge",
  ): IpSafetySignal => ({
    kind: "protected_mark_reproduction",
    confidence,
    evidence,
  });

  function withSignal(message: string, sig: IpSafetySignal | null) {
    return ip.evaluateCustomerRequest({ message, semanticSignal: sig }).outcome;
  }

  /** A: the safe evidence governs the SAME request the signal is about. */
  it("A: same-request negation is still allowed despite an explicit signal", () => {
    assert.equal(
      withSignal(
        "Don't use the Fictitious Rovers logo.",
        reproduction("explicit", "the Fictitious Rovers logo"),
      ),
      "allow",
    );
  });

  /** B: removal, same request. */
  it("B: same-request removal is still allowed despite an unsafe signal", () => {
    assert.equal(
      withSignal(
        "Remove the Fictitious Rovers badge.",
        reproduction("explicit", "the Fictitious Rovers badge"),
      ),
      "allow",
    );
  });

  /** C: the audited defect — decoy neutralization, surviving reproduction. */
  it("C: a decoy negation does not immunize a surviving reproduction request", () => {
    assert.equal(
      withSignal(
        "Don't use the old logo, recreate the Fictitious Rovers badge.",
        reproduction("explicit"),
      ),
      "block",
    );
  });

  /** D: inferred participates in blocking today; that behavior is preserved. */
  it("D: the same input blocks on an inferred signal too", () => {
    assert.equal(
      withSignal(
        "Don't use the old logo, recreate the Fictitious Rovers badge.",
        reproduction("inferred"),
      ),
      "block",
    );
  });

  /** E: a known mark safely removed, alongside an unknown one being copied. */
  it("E: a genuinely safe clause does not cover a semantic-only unsafe clause", () => {
    assert.equal(
      withSignal(
        "Remove the Nike logo, recreate the Fictitious Rovers badge.",
        reproduction("explicit"),
      ),
      "block",
    );
  });

  /** F: two unknown referents — one negated, one being reproduced. */
  it("F: two different unknown referents — the surviving request still blocks", () => {
    assert.equal(
      withSignal(
        "Don't use the Acme Falcons logo, recreate the Fictitious Rovers badge.",
        reproduction("explicit"),
      ),
      "block",
    );
  });

  /** The remaining audited decoy shapes. */
  const decoys = [
    "Don't change the logo, copy the Fictitious Rovers badge.",
    "Don't use the old Raiders logo; reproduce the Fictitious Rovers crest.",
  ];
  for (const message of decoys) {
    it(`decoy shape still blocks — "${message}"`, () => {
      assert.equal(withSignal(message, reproduction("explicit")), "block");
    });
  }

  /** G: genuine originality — the safe evidence explains the same request. */
  it("G: a negation followed by a request for original work is allowed", () => {
    assert.equal(
      withSignal(
        "Don't use the Fictitious Rovers logo; make something completely original.",
        reproduction("explicit", "Don't use the Fictitious Rovers logo"),
      ),
      "allow",
    );
  });

  /** H: a malformed signal is already sanitized away upstream. */
  it("H: a malformed signal leaves the deterministic result alone and does not throw", () => {
    for (const malformed of [
      {} as unknown as IpSafetySignal,
      { kind: "not_a_kind", confidence: "explicit", evidence: "x" } as unknown as IpSafetySignal,
      { kind: "protected_mark_reproduction" } as unknown as IpSafetySignal,
    ]) {
      // Whatever reaches the capability, the deterministic verdict stands.
      assert.equal(
        ip.evaluateCustomerRequest({
          message: "Make a black and silver football design.",
          semanticSignal: malformed,
        }).outcome,
        "allow",
      );
      assert.equal(
        ip.evaluateCustomerRequest({
          message: "Make me the Raiders logo.",
          semanticSignal: malformed,
        }).outcome,
        "block",
      );
    }
  });

  /** I: ambiguous never creates a refusal, decoy or not. */
  it("I: an ambiguous signal does not block even the decoy shape", () => {
    assert.equal(
      withSignal(
        "Don't use the old logo, recreate the Fictitious Rovers badge.",
        reproduction("ambiguous"),
      ),
      "allow",
    );
  });

  it("with no signal at all, the decoy shape is simply unknown to the deterministic layer", () => {
    assert.equal(
      withSignal("Don't use the old logo, recreate the Fictitious Rovers badge.", null),
      "allow",
    );
  });

  /**
   * The scoping must not leak into the deterministic verdict — an ownership
   * claim still explains its own clause, which is what keeps a business
   * customer's own branding usable.
   */
  it("an ownership claim still explains its own request", () => {
    assert.equal(
      withSignal(
        "Recreate our Rivera Plumbing logo.",
        reproduction("explicit", "our Rivera Plumbing logo"),
      ),
      "allow",
    );
  });

  it("but an ownership claim does not cover a separate surviving request", () => {
    assert.equal(
      withSignal(
        "Recreate our logo, and copy the Fictitious Rovers badge.",
        reproduction("explicit", "copy the Fictitious Rovers badge"),
      ),
      "block",
    );
  });
});

/**
 * CORRECTION 3 — SUPPRESSION IS SCOPED TO THE SAME REQUEST.
 *
 * Two audited bypasses, one root cause: safe evidence was matched against
 * the whole clause/subject rather than against the request the semantic
 * signal is actually about.
 *
 *   Blocker 1  "Recreate our logo, then reproduce theirs."
 *              — a possessive in the first instruction excused the second.
 *
 *   Blocker 2  "Don't use the old logo, draw that famous cartoon mouse
 *              exactly." — a neutralized logo excused a character request
 *              the deterministic lexicon cannot see at all.
 *
 * The second is why the rule had to become positional: no occurrence,
 * lexicon entry, or counter can represent "that famous cartoon mouse". The
 * signal's own quote is the only handle on where its request lives.
 *
 * Every invented name here ("Fictitious Rovers", "that famous cartoon
 * mouse", "the well-known princess") is deliberately absent from the
 * deterministic lexicon. Adding any of them would prove nothing.
 */
describe("Correction 3 — ownership is request-scoped", () => {
  const mark = (
    confidence: IpSafetySignal["confidence"],
    evidence: string,
  ): IpSafetySignal => ({
    kind: "protected_mark_reproduction",
    confidence,
    evidence,
  });

  function withSignal(message: string, sig: IpSafetySignal) {
    return ip.evaluateCustomerRequest({ message, semanticSignal: sig }).outcome;
  }

  /** A, F: a possessive genuinely covering its own request. */
  const owned: Array<[message: string, evidence: string]> = [
    ["Recreate our logo.", "Recreate our logo"],
    ["Make our company logo bigger.", "our company logo"],
    ["Recreate our Rivera Plumbing logo.", "our Rivera Plumbing logo"],
  ];
  for (const [message, evidence] of owned) {
    it(`allows a customer's own branding — "${message}"`, () => {
      assert.equal(withSignal(message, mark("explicit", evidence)), "allow");
    });
  }

  /** B–E, G: a possessive must never reach a second instruction. */
  const ownershipBypasses: Array<[message: string, evidence: string]> = [
    ["Recreate our logo, then reproduce theirs.", "reproduce theirs"],
    ["Make our logo bigger and copy theirs.", "copy theirs"],
    ["Use our mark, then recreate that badge.", "recreate that badge"],
    ["Recreate ours, copy the other team's.", "copy the other team's"],
    [
      "We own our logo, reproduce the Fictitious Rovers badge.",
      "reproduce the Fictitious Rovers badge",
    ],
    [
      "Keep our company logo, copy the Fictitious Rovers badge.",
      "copy the Fictitious Rovers badge",
    ],
  ];
  for (const [message, evidence] of ownershipBypasses) {
    it(`blocks a second, unowned request — "${message}"`, () => {
      assert.equal(withSignal(message, mark("explicit", evidence)), "block");
    });
  }
});

describe("Correction 3 — a semantic-only request cannot be immunized", () => {
  const character = (
    confidence: IpSafetySignal["confidence"],
    evidence: string,
  ): IpSafetySignal => ({
    kind: "protected_character_reproduction",
    confidence,
    evidence,
  });

  function withSignal(message: string, sig: IpSafetySignal) {
    return ip.evaluateCustomerRequest({ message, semanticSignal: sig }).outcome;
  }

  /** H, J, K: unrelated safe wording must not cover the character request. */
  const bypasses: Array<[message: string, evidence: string]> = [
    [
      "Don't use the old logo, draw that famous cartoon mouse exactly.",
      "draw that famous cartoon mouse exactly",
    ],
    [
      "Remove the old badge, use the exact character from that movie.",
      "use the exact character from that movie",
    ],
    [
      "Don't use the old logo, draw the well-known princess exactly like the original.",
      "draw the well-known princess exactly like the original",
    ],
  ];
  for (const [message, evidence] of bypasses) {
    it(`blocks the surviving character request — "${message}"`, () => {
      assert.equal(withSignal(message, character("explicit", evidence)), "block");
    });
  }

  /** I: inferred participates in blocking today; that is preserved. */
  it("I: the same input blocks on an inferred signal too", () => {
    assert.equal(
      withSignal(
        "Don't use the old logo, draw that famous cartoon mouse exactly.",
        character("inferred", "draw that famous cartoon mouse exactly"),
      ),
      "block",
    );
  });

  /** L, M, N: genuine same-request negation, removal, and avoidance. */
  const genuinelySafe: Array<[message: string, evidence: string]> = [
    ["Don't use that famous cartoon mouse.", "that famous cartoon mouse"],
    ["Remove that character from the design.", "that character"],
    [
      "Make something completely original instead of that character.",
      "that character",
    ],
  ];
  for (const [message, evidence] of genuinelySafe) {
    it(`allows the customer ruling the character out — "${message}"`, () => {
      assert.equal(withSignal(message, character("explicit", evidence)), "allow");
    });
  }

  it("no character lexicon is involved in either direction", () => {
    // The deterministic layer has no opinion about any of these sentences.
    for (const [message] of [...bypasses, ...genuinelySafe]) {
      assert.equal(ip.evaluateCustomerRequest({ message }).outcome, "allow");
    }
  });
});

/**
 * CORRECTION 4 — the two ways a positional rule can be gamed.
 *
 * Correction 3 made semantic suppression positional: the signal's quote must
 * sit inside deterministic safe evidence. Two implementation details of that
 * lookup were exploitable, and both are spend defects rather than cosmetic
 * ones, because the entities involved are invisible to the deterministic
 * layer by construction.
 */
describe("Correction 4 — duplicate evidence occurrences", () => {
  const mark = (evidence: string): IpSafetySignal => ({
    kind: "protected_mark_reproduction",
    confidence: "explicit",
    evidence,
  });

  function withEvidence(message: string, evidence: string) {
    return ip.evaluateCustomerRequest({ message, semanticSignal: mark(evidence) })
      .outcome;
  }

  /**
   * The audited exploit: repeat the phrase, negate the first copy, and the
   * first-match lookup declared the whole signal explained.
   */
  it("a safely covered first occurrence does not immunize an identical later one", () => {
    assert.equal(
      withEvidence(
        "Don't use the Fictitious Rovers logo, then recreate the Fictitious Rovers logo.",
        "Fictitious Rovers logo",
      ),
      "block",
    );
  });

  it("the same holds in the inverse order — unsafe first, safe second", () => {
    assert.equal(
      withEvidence(
        "Recreate the Fictitious Rovers logo, then don't use the Fictitious Rovers logo.",
        "Fictitious Rovers logo",
      ),
      "block",
    );
  });

  it("but genuinely repeating a safe instruction is still allowed", () => {
    assert.equal(
      withEvidence(
        "Don't use the Fictitious Rovers logo, and don't add the Fictitious Rovers logo.",
        "Fictitious Rovers logo",
      ),
      "allow",
    );
  });

  it("three occurrences with one uncovered still blocks", () => {
    assert.equal(
      withEvidence(
        "Don't use the Fictitious Rovers logo, don't add the Fictitious Rovers logo, then recreate the Fictitious Rovers logo.",
        "Fictitious Rovers logo",
      ),
      "block",
    );
  });
});

describe("Correction 4 — the whole evidence span must be covered", () => {
  const mark = (evidence: string): IpSafetySignal => ({
    kind: "protected_mark_reproduction",
    confidence: "explicit",
    evidence,
  });

  function withEvidence(message: string, evidence: string) {
    return ip.evaluateCustomerRequest({ message, semanticSignal: mark(evidence) })
      .outcome;
  }

  /**
   * Start-only containment let a quote begin inside a negation and run out
   * the other side of it, carrying the unsafe half along under cover of the
   * safe half. Every scope terminator is exercised, because each one is a
   * place a quote could straddle.
   */
  const straddling: Array<[terminator: string, message: string, evidence: string]> = [
    [
      "comma",
      "Don't use the old logo, recreate the Fictitious Rovers badge.",
      "old logo, recreate the Fictitious Rovers badge",
    ],
    [
      "semicolon",
      "Don't use the old logo; recreate the Fictitious Rovers badge.",
      "old logo; recreate the Fictitious Rovers badge",
    ],
    [
      "colon",
      "Don't use the old logo: recreate the Fictitious Rovers badge.",
      "old logo: recreate the Fictitious Rovers badge",
    ],
    [
      "and",
      "Don't use the old logo and recreate the Fictitious Rovers badge.",
      "old logo and recreate the Fictitious Rovers badge",
    ],
    [
      "but",
      "Don't use the old logo but recreate the Fictitious Rovers badge.",
      "old logo but recreate the Fictitious Rovers badge",
    ],
    [
      "then",
      "Don't use the old logo then recreate the Fictitious Rovers badge.",
      "old logo then recreate the Fictitious Rovers badge",
    ],
    [
      "just",
      "Don't use the old logo just recreate the Fictitious Rovers badge.",
      "old logo just recreate the Fictitious Rovers badge",
    ],
    [
      "while",
      "Don't use the old logo while you recreate the Fictitious Rovers badge.",
      "old logo while you recreate the Fictitious Rovers badge",
    ],
  ];

  for (const [terminator, message, evidence] of straddling) {
    it(`blocks a quote straddling a "${terminator}" boundary`, () => {
      assert.equal(withEvidence(message, evidence), "block");
    });

    it(`and the deterministic layer has no opinion about it — "${terminator}"`, () => {
      // Proves the semantic locator is what these cases actually exercise.
      assert.equal(ip.evaluateCustomerRequest({ message }).outcome, "allow");
    });
  }

  it("a quote that ends exactly at the scope boundary is still covered", () => {
    assert.equal(
      withEvidence(
        "Don't use the Fictitious Rovers logo; make something completely original.",
        "Don't use the Fictitious Rovers logo",
      ),
      "allow",
    );
  });

  /** Containment applies identically to ownership-explained segments. */
  it("an ownership segment must also contain the whole quote", () => {
    assert.equal(
      withEvidence("Recreate our logo, then reproduce theirs.", "our logo, then reproduce theirs"),
      "block",
    );
    assert.equal(
      withEvidence("Recreate our Rivera Plumbing logo.", "our Rivera Plumbing logo"),
      "allow",
    );
  });
});

/** Goal 6: one valid safe action alongside one unsafe request. */
describe("Correction 3 — mixed safe and unsafe instructions", () => {
  const sig = (
    kind: IpSafetySignal["kind"],
    evidence: string,
  ): IpSafetySignal => ({ kind, confidence: "explicit", evidence });

  it("blocks a character request that follows a genuine logo removal", () => {
    assert.equal(
      ip.evaluateCustomerRequest({
        message: "Remove the Nike logo, then draw the famous cartoon mouse exactly.",
        semanticSignal: sig(
          "protected_character_reproduction",
          "draw the famous cartoon mouse exactly",
        ),
      }).outcome,
      "block",
    );
  });

  it("blocks a character request that follows a genuine mark negation", () => {
    assert.equal(
      ip.evaluateCustomerRequest({
        message: "Don't use the Raiders shield, recreate the movie character exactly.",
        semanticSignal: sig(
          "protected_character_reproduction",
          "recreate the movie character exactly",
        ),
      }).outcome,
      "block",
    );
  });

  it("allows a removal with no surviving reproduction request", () => {
    assert.equal(
      ip.evaluateCustomerRequest({
        message: "Remove their old logo and make something completely original.",
      }).outcome,
      "allow",
    );
    assert.equal(
      ip.evaluateCustomerRequest({
        message: "Remove their old logo and make something completely original.",
        semanticSignal: sig("protected_mark_reproduction", "Remove their old logo"),
      }).outcome,
      "allow",
    );
  });
});

describe("IpSafetyCapability — the customer-facing response (Goal 10, Goal P)", () => {
  const blockedMessages = [
    "Make me the Raiders logo.",
    "Make a knockoff version.",
    "Make Mickey Mouse wearing a football jersey.",
    "Use this image and make the logo exactly the same.",
  ];

  it("says nothing at all when a request is allowed", () => {
    assert.equal(
      describeIpSafetyDecisionForCustomer(
        ip.evaluateCustomerRequest({ message: "Make a pirate skull." }),
      ),
      null,
    );
  });

  it("P: no internal reason enum can ever reach the customer", () => {
    for (const message of blockedMessages) {
      const decision = ip.evaluateCustomerRequest({ message });
      const response = describeIpSafetyDecisionForCustomer(decision);
      assert.ok(response);
      assert.ok(decision.reasons.length > 0, message);
      for (const reason of decision.reasons) {
        assert.doesNotMatch(response, new RegExp(reason, "i"));
      }
      assert.doesNotMatch(
        response,
        /third_party|recognizable_mark|protected_character|protection_evasion|reason|enum|policy|detect|flagg?ed|violat/i,
      );
    }
  });

  it("P: every blocked reason produces the identical wording, so the classification cannot be read off the prose", () => {
    const responses = new Set(
      blockedMessages.map((message) =>
        describeIpSafetyDecisionForCustomer(ip.evaluateCustomerRequest({ message })),
      ),
    );
    assert.equal(responses.size, 1);
    assert.equal([...responses][0], IP_SAFETY_REDIRECT_MESSAGE);
  });

  it("makes no legal claim and accuses the customer of nothing", () => {
    assert.doesNotMatch(
      IP_SAFETY_REDIRECT_MESSAGE,
      /infring|illegal|unlawful|lawsuit|sue|legally|licensed|cleared|copyright|trademark|you\s+(?:may|cannot|can't)\s+not/i,
    );
  });

  it("redirects toward an original design rather than dead-ending", () => {
    assert.match(IP_SAFETY_REDIRECT_MESSAGE, /original/i);
    assert.match(IP_SAFETY_REDIRECT_MESSAGE, /colors|theme|feel|style/i);
  });
});
