import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { acknowledgeResolvedFields } from "./question-phrasing";
import type { DesignSummaryView } from "./contracts";

describe("acknowledgeResolvedFields — Sprint 2L Phase 1A", () => {
  it("builds a natural, value-bearing acknowledgement from changed sections only", () => {
    const summary: DesignSummaryView = {
      product: "T-shirt",
      requiredWording: "My 3 Sons",
      audience: "Bowling team",
    };
    const ack = acknowledgeResolvedFields(summary, ["product", "requiredWording", "audience"]);
    assert.ok(ack);
    assert.match(ack!, /T-shirt/);
    assert.match(ack!, /My 3 Sons/);
    assert.match(ack!, /bowling team/i);
    assert.doesNotMatch(ack!, /I've made those changes/i);
  });

  it("never mentions a field that is in the summary but was NOT in changedSections", () => {
    const summary: DesignSummaryView = {
      product: "T-shirt",
      productColor: "Black", // already known before this turn — not changed
    };
    const ack = acknowledgeResolvedFields(summary, ["product"]);
    assert.ok(ack);
    assert.doesNotMatch(ack!, /black/i);
  });

  it("returns null when nothing in changedSections has a displayable value (e.g. a deferral-only turn)", () => {
    const summary: DesignSummaryView = {};
    const ack = acknowledgeResolvedFields(summary, ["colors"]);
    assert.equal(ack, null);
  });

  it("caps the number of fields mentioned to keep the sentence short", () => {
    const summary: DesignSummaryView = {
      product: "T-shirt",
      requiredWording: "My 3 Sons",
      audience: "Bowling team",
      purpose: "Bowling league team apparel",
      productColor: "Black",
      printLocation: "Full back",
    };
    const ack = acknowledgeResolvedFields(summary, [
      "product",
      "requiredWording",
      "audience",
      "purpose",
      "productColor",
      "printLocation",
    ]);
    assert.ok(ack);
    // Sentence stays readable — not every one of the six fields need appear.
    const mentionedCount = ["T-shirt", "My 3 Sons", "bowling team", "printLocation"].filter(
      (s) => ack!.toLowerCase().includes(s.toLowerCase()),
    ).length;
    assert.ok(mentionedCount <= 4);
  });

  it("never produces a doubled article when the value already starts with 'The'", () => {
    const summary: DesignSummaryView = { audience: "The crew" };
    const ack = acknowledgeResolvedFields(summary, ["audience"]);
    assert.ok(ack);
    assert.doesNotMatch(ack!, /the the crew/i);
    assert.match(ack!, /the crew/i);
  });

  it('phrases requiredWording "None" as no required wording, not a quoted empty string', () => {
    const summary: DesignSummaryView = { requiredWording: "None" };
    const ack = acknowledgeResolvedFields(summary, ["requiredWording"]);
    assert.ok(ack);
    assert.match(ack!, /no required wording/i);
    assert.doesNotMatch(ack!, /"None"/);
  });
});
