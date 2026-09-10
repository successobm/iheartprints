import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveArtworkFidelityProposalProvider } from "./resolve-artwork-fidelity-proposal-provider";
import { PlaceholderArtworkFidelityProposalProvider } from "./placeholder-artwork-fidelity-proposal-provider";
import { OpenAIArtworkFidelityProposalProvider } from "./openai-artwork-fidelity-proposal-provider";

describe("resolveArtworkFidelityProposalProvider", () => {
  it("resolves the placeholder for an explicit placeholder config", () => {
    const provider = resolveArtworkFidelityProposalProvider({ mode: "placeholder", reason: "configured" });
    assert.ok(provider instanceof PlaceholderArtworkFidelityProposalProvider);
  });

  it("resolves the real OpenAI provider for an explicit openai config", () => {
    const provider = resolveArtworkFidelityProposalProvider({ mode: "openai", apiKey: "sk-test", model: "gpt-4o-mini" });
    assert.ok(provider instanceof OpenAIArtworkFidelityProposalProvider);
  });

  it("unconditionally forces the placeholder under isAutomatedTestEnvironment(), regardless of ambient env vars, when config is omitted", () => {
    // This test file itself runs under IHEARTPRINTS_AUTOMATED_TEST=1 (set by
    // the shared test bootstrap) -- calling with NO config must never reach
    // for a real network-backed provider no matter what ARTWORK_FIDELITY_
    // PROPOSAL_PROVIDER/OPENAI_API_KEY happen to be set to in this process.
    const previousProvider = process.env.ARTWORK_FIDELITY_PROPOSAL_PROVIDER;
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.ARTWORK_FIDELITY_PROPOSAL_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-live-looking-but-must-never-be-used";
    try {
      const provider = resolveArtworkFidelityProposalProvider();
      assert.ok(provider instanceof PlaceholderArtworkFidelityProposalProvider);
    } finally {
      if (previousProvider === undefined) delete process.env.ARTWORK_FIDELITY_PROPOSAL_PROVIDER;
      else process.env.ARTWORK_FIDELITY_PROPOSAL_PROVIDER = previousProvider;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  });
});
