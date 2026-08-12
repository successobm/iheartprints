import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ABSOLUTE_MAX_PAID_INTENTS_PER_JOB,
  buildPaidImageIntentKey,
  MAX_PAID_DISPATCHES_PER_INTENT,
  MAX_REPLACEMENT_PAID_INTENTS_PER_JOB,
  ORIGINAL_PAID_INTENT_EPOCH,
  paidIntentBudgetForJob,
} from "./paid-image-intent";

/**
 * Phase 2C0.5 (§2): the LOGICAL PAID INTENT IDENTITY CONTRACT, tested as a
 * contract rather than as an implementation.
 *
 * The contract has two halves and both are load-bearing for spend safety:
 *   - it MUST distinguish genuinely different paid operations, or a
 *     replacement would silently recover an image it was meant to replace;
 *   - it MUST NOT change for a reclaim, an attempt, a retry, a timestamp,
 *     or a provider request id, or recovery would re-buy artwork the
 *     platform already owns.
 */
describe("logical paid image intent identity", () => {
  const base = {
    projectId: "project-1",
    generationJobId: "job-1",
    scopeKey: "bold_direct" as const,
  };

  it("is deterministic — the same identity always produces the same key", () => {
    const first = buildPaidImageIntentKey({ ...base, kind: "initial_concept" });
    const second = buildPaidImageIntentKey({ ...base, kind: "initial_concept" });
    assert.equal(first, second);
  });

  it("distinguishes each catalog direction within one job", () => {
    const keys = new Set(
      (["bold_direct", "soft_illustrated", "minimal_badge"] as const).map(
        (scopeKey) =>
          buildPaidImageIntentKey({ ...base, scopeKey, kind: "initial_concept" }),
      ),
    );
    assert.equal(keys.size, 3);
  });

  it("distinguishes an initial concept, a targeted revision, and a Phase 2C replacement", () => {
    const initial = buildPaidImageIntentKey({ ...base, kind: "initial_concept" });
    const revision = buildPaidImageIntentKey({
      ...base,
      kind: "targeted_revision",
      targetArtworkVersionId: "artwork-1",
    });
    const replacement = buildPaidImageIntentKey({
      ...base,
      kind: "replacement",
      replacedArtworkVersionId: "artwork-1",
      epoch: 1,
    });
    assert.equal(new Set([initial, revision, replacement]).size, 3);
  });

  it("distinguishes two intentional revisions of the SAME artwork, because each is its own job", () => {
    const first = buildPaidImageIntentKey({
      ...base,
      generationJobId: "job-1",
      kind: "targeted_revision",
      targetArtworkVersionId: "artwork-1",
    });
    const second = buildPaidImageIntentKey({
      ...base,
      generationJobId: "job-2",
      kind: "targeted_revision",
      targetArtworkVersionId: "artwork-1",
    });
    assert.notEqual(first, second);
  });

  it("distinguishes an intentional Explore/new batch, which owns its own job", () => {
    const firstBatch = buildPaidImageIntentKey({
      ...base,
      generationJobId: "job-batch-1",
      kind: "initial_concept",
    });
    const secondBatch = buildPaidImageIntentKey({
      ...base,
      generationJobId: "job-batch-2",
      kind: "initial_concept",
    });
    assert.notEqual(firstBatch, secondBatch);
  });

  it("distinguishes replacement epochs, so Phase 2C can never recover the image it is replacing", () => {
    const first = buildPaidImageIntentKey({
      ...base,
      kind: "replacement",
      replacedArtworkVersionId: "artwork-1",
      epoch: 1,
    });
    const second = buildPaidImageIntentKey({
      ...base,
      kind: "replacement",
      replacedArtworkVersionId: "artwork-1",
      epoch: 2,
    });
    assert.notEqual(first, second);
  });

  it("scopes by project, so two projects can never share a paid intent", () => {
    assert.notEqual(
      buildPaidImageIntentKey({ ...base, projectId: "a", kind: "initial_concept" }),
      buildPaidImageIntentKey({ ...base, projectId: "b", kind: "initial_concept" }),
    );
  });

  it("defaults to the original epoch, and states it explicitly in the key", () => {
    const key = buildPaidImageIntentKey({ ...base, kind: "initial_concept" });
    assert.equal(ORIGINAL_PAID_INTENT_EPOCH, 0);
    assert.match(key, /:e0:/);
  });

  it("refuses a targeted revision with no target and a replacement with nothing replaced", () => {
    assert.throws(
      () => buildPaidImageIntentKey({ ...base, kind: "targeted_revision" }),
      /requires targetArtworkVersionId/,
    );
    assert.throws(
      () => buildPaidImageIntentKey({ ...base, kind: "replacement" }),
      /requires replacedArtworkVersionId/,
    );
  });

  it("refuses a nonsensical epoch rather than silently normalizing it", () => {
    assert.throws(
      () => buildPaidImageIntentKey({ ...base, kind: "initial_concept", epoch: -1 }),
      /non-negative integer/,
    );
  });

  /**
   * The negative half of the contract, stated as one test because these are
   * the exact inputs that must NEVER reach the identity. Every one of them
   * changes on a reclaim; if any leaked in, recovery would re-buy artwork.
   */
  it("encodes nothing that varies between attempts — no timestamp, uuid, attempt number, or provider request id", () => {
    const key = buildPaidImageIntentKey({
      ...base,
      kind: "targeted_revision",
      targetArtworkVersionId: "artwork-1",
    });

    assert.doesNotMatch(key, /\d{4}-\d{2}-\d{2}T/, "no timestamp");
    assert.doesNotMatch(
      key,
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      "no random uuid (the ids present are the caller's own durable ones)",
    );
    assert.doesNotMatch(key, /attempt/i);
    assert.doesNotMatch(key, /req[-_]/i);

    assert.equal(
      key,
      "paid-image:v1:project-1:job-1:targeted_revision:e0:t=artwork-1:d=bold_direct",
      "the key is composed only of durable, deterministic facts",
    );
  });
});

describe("paid image intent budget", () => {
  it("gives an initial three-direction job its three intents plus the Phase 2C replacement allowance", () => {
    assert.equal(paidIntentBudgetForJob(3), 5);
    assert.equal(MAX_REPLACEMENT_PAID_INTENTS_PER_JOB, 2);
  });

  it("gives a one-concept targeted revision its own smaller budget", () => {
    assert.equal(paidIntentBudgetForJob(1), 3);
  });

  it("never exceeds the absolute per-job ceiling, whatever the concept count claims", () => {
    assert.equal(ABSOLUTE_MAX_PAID_INTENTS_PER_JOB, 5);
    for (const conceptCount of [4, 10, 100]) {
      assert.equal(
        paidIntentBudgetForJob(conceptCount),
        ABSOLUTE_MAX_PAID_INTENTS_PER_JOB,
      );
    }
  });

  it("treats a nonsensical concept count as one intent rather than as unlimited", () => {
    assert.equal(paidIntentBudgetForJob(0), 3);
    assert.equal(paidIntentBudgetForJob(-5), 3);
    assert.equal(paidIntentBudgetForJob(Number.NaN), 3);
  });

  it("bounds dispatches per single image, so one image can never be bought without limit", () => {
    assert.ok(MAX_PAID_DISPATCHES_PER_INTENT >= 1);
    assert.ok(MAX_PAID_DISPATCHES_PER_INTENT <= 3);
  });
});
