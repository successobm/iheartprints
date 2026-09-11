import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import { createArtworkFidelityProposalCapability } from "./artwork-fidelity-proposal-capability";
import type {
  ArtworkFidelityProposalImageInput,
  ArtworkFidelityProposalProvider,
} from "./artwork-fidelity-proposal-provider";
import type { ArtworkFidelityProposalResult } from "./contracts";
import { ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION } from "./contracts";

function solidPng(width = 40, height = 40): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 10;
    png.data[i + 1] = 20;
    png.data[i + 2] = 30;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

class FakeProvider implements ArtworkFidelityProposalProvider {
  readonly providerKey = "fake_provider";
  calls: ArtworkFidelityProposalImageInput[] = [];
  constructor(private readonly result: ArtworkFidelityProposalResult | (() => never)) {}
  async propose(input: ArtworkFidelityProposalImageInput): Promise<ArtworkFidelityProposalResult> {
    this.calls.push(input);
    if (typeof this.result === "function") return this.result();
    return this.result;
  }
}

describe("ArtworkFidelityProposalCapability", () => {
  it("wraps a successful provider result into a stamped proposedFacts payload, assigning stable proposal-local ids", async () => {
    const provider = new FakeProvider({
      wording: [{ text: "BRIDGEWELL", readability: "readable", confidence: "high", visibleEvidence: "bold caps" }],
      protectedMarks: [{ visualDescription: "letter R enclosed by a circle", classification: "R", confidence: "medium" }],
      providerRequestId: "resp_123",
      analyzed: true,
    });
    const capability = createArtworkFidelityProposalCapability(provider);

    const facts = await capability.proposeFacts({ bytes: solidPng(), contentType: "image/png" });

    assert.equal(facts.schemaVersion, ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION);
    assert.equal(facts.proposalStatus, "analyzed");
    assert.equal(facts.wording.length, 1);
    assert.equal(facts.wording[0]!.id, "w0");
    assert.equal(facts.wording[0]!.text, "BRIDGEWELL");
    assert.equal(facts.protectedMarks.length, 1);
    assert.equal(facts.protectedMarks[0]!.id, "m0");
    assert.equal(facts.protectedMarks[0]!.classification, "R");
    assert.equal(facts.sanitizedProvider.providerKey, "fake_provider");
    // Sanitized provider metadata carries no raw request id, no bytes, no credential.
    assert.equal(Object.keys(facts.sanitizedProvider).sort().join(","), "proposedAt,providerKey");
  });

  it("assigns distinct, stable, position-derived ids across multiple entries", async () => {
    const provider = new FakeProvider({
      wording: [
        { text: "REGENCY", readability: "readable", confidence: "high", visibleEvidence: "a" },
        { text: null, readability: "cannot_read", confidence: "low", visibleEvidence: "b" },
      ],
      protectedMarks: [
        { visualDescription: "a", classification: "TM", confidence: "high" },
        { visualDescription: "b", classification: "cannot_determine", confidence: "low" },
      ],
      providerRequestId: null,
      analyzed: true,
    });
    const capability = createArtworkFidelityProposalCapability(provider);

    const facts = await capability.proposeFacts({ bytes: solidPng(), contentType: "image/png" });

    assert.deepEqual(facts.wording.map((w) => w.id), ["w0", "w1"]);
    assert.deepEqual(facts.protectedMarks.map((m) => m.id), ["m0", "m1"]);
  });

  it("REPAIR (Blocker 3): a genuine successful provider response with ZERO facts reports proposalStatus: \"analyzed\", with a synthesized catch-all mark region requiring resolution", async () => {
    const provider = new FakeProvider({ wording: [], protectedMarks: [], providerRequestId: "resp_456", analyzed: true });
    const capability = createArtworkFidelityProposalCapability(provider);

    const facts = await capability.proposeFacts({ bytes: solidPng(), contentType: "image/png" });

    assert.equal(facts.proposalStatus, "analyzed");
    assert.deepEqual(facts.wording, []);
    assert.equal(facts.protectedMarks.length, 1);
    assert.equal(facts.protectedMarks[0]!.id, "m0");
    assert.equal(facts.protectedMarks[0]!.classification, "cannot_determine");
  });

  it("downscales before handing bytes to the provider", async () => {
    const provider = new FakeProvider({ wording: [], protectedMarks: [], providerRequestId: null, analyzed: true });
    const capability = createArtworkFidelityProposalCapability(provider);

    await capability.proposeFacts({ bytes: solidPng(4000, 4000), contentType: "image/png" });

    assert.equal(provider.calls.length, 1);
    const sent = PNG.sync.read(provider.calls[0]!.bytes);
    assert.ok(Math.max(sent.width, sent.height) <= 1600);
  });

  it("REPAIR (Blocker 3): NEVER throws for a provider failure -- degrades to proposalStatus: \"unavailable\", never \"analyzed\"", async () => {
    const provider = new FakeProvider(() => {
      throw new Error("network exploded");
    });
    const capability = createArtworkFidelityProposalCapability(provider);

    const facts = await capability.proposeFacts({ bytes: solidPng(), contentType: "image/png" });

    assert.equal(facts.proposalStatus, "unavailable");
    assert.deepEqual(facts.wording, []);
    // Still exactly one catch-all mark region requiring resolution -- a
    // thrown provider failure must not leave zero mark fields to resolve,
    // which would let confirmation trivially imply "no marks" with no
    // explicit customer decision at all.
    assert.equal(facts.protectedMarks.length, 1);
    assert.equal(facts.protectedMarks[0]!.id, "m0");
    assert.equal(facts.schemaVersion, ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION);
  });

  it("degrades to proposalStatus: \"unavailable\" for bytes that do not decode as a PNG, without calling the provider", async () => {
    const provider = new FakeProvider({
      wording: [{ text: "should never be reached", readability: "readable", confidence: "high", visibleEvidence: "" }],
      protectedMarks: [],
      providerRequestId: null,
      analyzed: true,
    });
    const capability = createArtworkFidelityProposalCapability(provider);

    const facts = await capability.proposeFacts({ bytes: Buffer.from("not a png"), contentType: "image/png" });

    assert.equal(facts.proposalStatus, "unavailable");
    assert.deepEqual(facts.wording, []);
    assert.equal(provider.calls.length, 0);
  });

  it("REPAIR (Blocker 3): a provider reporting analyzed: false (e.g. the placeholder) is \"unavailable\" even though it returned successfully with no thrown error", async () => {
    const provider = new FakeProvider({ wording: [], protectedMarks: [], providerRequestId: null, analyzed: false });
    const capability = createArtworkFidelityProposalCapability(provider);

    const facts = await capability.proposeFacts({ bytes: solidPng(), contentType: "image/png" });

    assert.equal(facts.proposalStatus, "unavailable");
  });
});
