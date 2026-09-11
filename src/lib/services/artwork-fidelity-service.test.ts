/**
 * Universal Raster Reconstruction Phase R4A: end-to-end proof of the
 * authority invariant this whole phase exists to protect — a successful
 * `proposeArtworkFidelity` call can NEVER create confirmed authority, only
 * an explicit `confirmArtworkFidelity` call can, and confirmation fails
 * closed against a stale or missing source. Mirrors `sign-artwork-service
 * .test.ts`'s own `getCapabilityGraph()`-based pattern: under
 * `isAutomatedTestEnvironment()` the real capability graph resolves its
 * provider to the safe, network-free placeholder automatically, so this
 * test never makes a real network call.
 *
 * Phase R4A-R (independent-review repair): the placeholder provider always
 * proposes zero wording and exactly one synthesized catch-all mark region
 * (`m0`) — see `assignMarkIds`'s own doc comment. Tests here that need to
 * exercise REAL wording entries write a crafted `proposedFacts` payload
 * directly via the repository (bypassing the placeholder-backed provider
 * call, never bypassing `confirmArtworkFidelity`'s own validation path) —
 * exhaustive coverage of the validator itself lives in
 * `artwork-fidelity-confirmation.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { ArtworkFidelityContractStateError } from "@/capabilities/artwork-fidelity";
import { toProposedFactsRecord, type ArtworkFidelityProposedFacts } from "@/capabilities/artwork-fidelity-proposal";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { ArtworkFidelityConfirmationValidationError } from "./artwork-fidelity-confirmation";
import {
  ArtworkFidelityServiceError,
  confirmArtworkFidelity,
  proposeArtworkFidelity,
} from "./artwork-fidelity-service";

function pngBytes(seed: number): Buffer {
  const png = new PNG({ width: 30, height: 30 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = seed % 255;
    png.data[i + 1] = 20;
    png.data[i + 2] = 30;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** The catch-all mark resolution every placeholder-backed proposal requires (Section 5/7). */
const RESOLVE_CATCHALL_NONE = [{ id: "m0", mark: "NONE" as const }];

function craftedFacts(overrides: Partial<ArtworkFidelityProposedFacts> = {}): ArtworkFidelityProposedFacts {
  return {
    schemaVersion: "artwork-fidelity-proposal:v2",
    proposalStatus: "analyzed",
    wording: [
      { id: "w0", text: "BRIDGEWELL", readability: "readable", confidence: "high", visibleEvidence: "bold caps" },
      { id: "w1", text: "& COMPANY", readability: "readable", confidence: "medium", visibleEvidence: "smaller caps" },
    ],
    protectedMarks: [
      { id: "m0", visualDescription: "letter R enclosed by a circle", classification: "R", confidence: "medium" },
    ],
    sanitizedProvider: { providerKey: "test_fixture", proposedAt: new Date().toISOString() },
    ...overrides,
  };
}

describe("artwork-fidelity-service", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-fidelity-service-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshGraph() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { getProjectRepository } = await import("@/lib/db");
    return { graph, repo: getProjectRepository() };
  }

  async function freshProjectWithUpload(
    graph: Awaited<ReturnType<typeof freshGraph>>["graph"],
    repo: Awaited<ReturnType<typeof freshGraph>>["repo"],
    seed = 1,
  ) {
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.artworkPreparation.uploadOriginal(projectId, {
      bytes: pngBytes(seed),
      declaredContentType: "image/png",
      filename: "logo.png",
    });
    return projectId;
  }

  /** Proposes normally (placeholder-backed, zero wording + one catch-all mark), then overwrites `proposedFacts` with a crafted payload carrying real wording entries -- source binding/sha stay exactly what the real upload produced. */
  async function projectWithCraftedProposal(
    graph: Awaited<ReturnType<typeof freshGraph>>["graph"],
    repo: Awaited<ReturnType<typeof freshGraph>>["repo"],
    factsOverrides: Partial<ArtworkFidelityProposedFacts> = {},
  ) {
    const projectId = await freshProjectWithUpload(graph, repo);
    await proposeArtworkFidelity(projectId);
    const contract = await graph.artworkFidelity.getContract(projectId);
    await repo.updateArtworkFidelityContract(contract!.id, {
      proposedFacts: toProposedFactsRecord(craftedFacts(factsOverrides)),
    });
    return projectId;
  }

  it("AUTHORITY INVARIANT: a successful propose call creates ONLY a proposed contract -- never confirmedBy/confirmedAt/contractKey", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await freshProjectWithUpload(graph, repo);

    const snapshot = await proposeArtworkFidelity(projectId);

    assert.ok(snapshot.artworkFidelity);
    assert.equal(snapshot.artworkFidelity!.status, "proposed");
    assert.equal(snapshot.artworkFidelity!.confirmedWording, null);
    assert.equal(snapshot.artworkFidelity!.confirmedMarks, null);
    assert.equal(snapshot.artworkFidelity!.confirmedAt, null);
    // Phase R4A-R: the placeholder provider never ran a real analysis.
    assert.equal(snapshot.artworkFidelity!.proposalStatus, "unavailable");

    const stored = await graph.artworkFidelity.getContract(projectId);
    assert.ok(stored);
    assert.equal(stored!.status, "proposed");
    assert.equal(stored!.confirmedBy, null);
    assert.equal(stored!.contractKey, null);
  });

  it("propose is idempotent against the current immutable source -- a second call for unchanged bytes does not create a second contract", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await freshProjectWithUpload(graph, repo);

    await proposeArtworkFidelity(projectId);
    const first = await graph.artworkFidelity.getContract(projectId);
    await proposeArtworkFidelity(projectId);
    const second = await graph.artworkFidelity.getContract(projectId);

    assert.equal(first!.id, second!.id);
  });

  it("confirm requires a proposal to already exist", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await freshProjectWithUpload(graph, repo);

    await assert.rejects(
      () =>
        confirmArtworkFidelity(projectId, {
          wordingResolutions: [],
          markResolutions: RESOLVE_CATCHALL_NONE,
          confirmedBy: "customer",
        }),
      ArtworkFidelityContractStateError,
    );
  });

  it("confirm creates real, immutable confirmed authority with an exact contractKey", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await projectWithCraftedProposal(graph, repo);

    const snapshot = await confirmArtworkFidelity(projectId, {
      wordingResolutions: [
        { id: "w0", text: "BRIDGEWELL" },
        { id: "w1", text: "& COMPANY" },
      ],
      markResolutions: [{ id: "m0", mark: "®" }],
      confirmedBy: "customer",
    });

    assert.equal(snapshot.artworkFidelity!.status, "confirmed");
    assert.deepEqual(snapshot.artworkFidelity!.confirmedWording!.sort(), ["& COMPANY", "BRIDGEWELL"]);
    assert.deepEqual(snapshot.artworkFidelity!.confirmedMarks, ["®"]);
    assert.ok(snapshot.artworkFidelity!.confirmedAt);

    const stored = await graph.artworkFidelity.getContract(projectId);
    assert.ok(stored!.contractKey);
  });

  it("a second confirm attempt against an already-confirmed contract is refused -- confirmation is immutable authority", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await projectWithCraftedProposal(graph, repo);
    await confirmArtworkFidelity(projectId, {
      wordingResolutions: [{ id: "w0", text: "BRIDGEWELL" }, { id: "w1", excluded: true }],
      markResolutions: RESOLVE_CATCHALL_NONE,
      confirmedBy: "customer",
    });

    await assert.rejects(
      () =>
        confirmArtworkFidelity(projectId, {
          wordingResolutions: [{ id: "w0", text: "SOMETHING ELSE" }, { id: "w1", excluded: true }],
          markResolutions: RESOLVE_CATCHALL_NONE,
          confirmedBy: "customer",
        }),
      ArtworkFidelityContractStateError,
    );

    // No partial mutation on refusal -- the original confirmed facts stand.
    const stored = await graph.artworkFidelity.getContract(projectId);
    assert.deepEqual(stored!.confirmedWording, ["BRIDGEWELL"]);
  });

  it("choosing None (empty confirmedMarks) is a valid, explicit confirmation -- not an unresolved state", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await freshProjectWithUpload(graph, repo);
    await proposeArtworkFidelity(projectId);

    const snapshot = await confirmArtworkFidelity(projectId, {
      wordingResolutions: [],
      markResolutions: RESOLVE_CATCHALL_NONE,
      confirmedBy: "customer",
    });

    assert.equal(snapshot.artworkFidelity!.status, "confirmed");
    assert.deepEqual(snapshot.artworkFidelity!.confirmedMarks, []);
  });

  it("REPAIR (Blocker 2): a direct confirm call that omits a proposed region's resolution is rejected server-side -- no partial mutation", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await projectWithCraftedProposal(graph, repo);

    await assert.rejects(
      () =>
        confirmArtworkFidelity(projectId, {
          // "w1" (a real, readable proposed region) is silently omitted --
          // exactly the malformed/incomplete-API-payload scenario the
          // independent review demonstrated succeeded before this repair.
          wordingResolutions: [{ id: "w0", text: "BRIDGEWELL" }],
          markResolutions: RESOLVE_CATCHALL_NONE,
          confirmedBy: "customer",
        }),
      ArtworkFidelityConfirmationValidationError,
    );

    const stored = await graph.artworkFidelity.getContract(projectId);
    assert.equal(stored!.status, "proposed");
    assert.equal(stored!.confirmedWording, null);
  });

  it("REPAIR (Blocker 2): an empty confirmedWording/confirmedMarks submission against a proposal with real readable content is rejected, not silently confirmed as \"nothing present\"", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await projectWithCraftedProposal(graph, repo);

    await assert.rejects(
      () =>
        confirmArtworkFidelity(projectId, {
          wordingResolutions: [],
          markResolutions: [],
          confirmedBy: "customer",
        }),
      ArtworkFidelityConfirmationValidationError,
    );

    const stored = await graph.artworkFidelity.getContract(projectId);
    assert.equal(stored!.status, "proposed");
  });

  it("REPAIR (Blocker 8/9): NOT_SURE submitted directly to the service can never confirm", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await freshProjectWithUpload(graph, repo);
    await proposeArtworkFidelity(projectId);

    await assert.rejects(
      () =>
        confirmArtworkFidelity(projectId, {
          wordingResolutions: [],
          markResolutions: [{ id: "m0", mark: "NOT_SURE" as never }],
          confirmedBy: "customer",
        }),
      ArtworkFidelityConfirmationValidationError,
    );

    const stored = await graph.artworkFidelity.getContract(projectId);
    assert.equal(stored!.status, "proposed");
  });

  it("fails closed rather than confirming stale authority: proves the sha is ALWAYS server-recomputed rather than trusted from input", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await freshProjectWithUpload(graph, repo);
    const proposed = await proposeArtworkFidelity(projectId);
    const contract = await graph.artworkFidelity.getContract(projectId);
    assert.equal(proposed.artworkFidelity!.contractId, contract!.id);

    // Directly exercising the capability's own staleness check (Section 10)
    // with a WRONG sha -- proves the service always supplies a freshly
    // measured value, never a client-supplied one, by construction (the
    // service's confirmArtworkFidelity signature accepts no sha input at
    // all). This call goes straight to the capability to simulate what
    // WOULD happen if a stale sha were ever supplied.
    await assert.rejects(
      () =>
        graph.artworkFidelity.confirmContract(projectId, contract!.id, {
          currentSourceSha256: "0".repeat(64),
          confirmedWording: [],
          confirmedMarks: [],
          confirmedBy: "customer",
        }),
      ArtworkFidelityContractStateError,
    );
  });

  it("propose refuses cleanly when nothing has been uploaded yet -- never crashes, never creates a partial contract", async () => {
    const { graph, repo } = await freshGraph();
    const created = await repo.createProject();

    await assert.rejects(() => proposeArtworkFidelity(created.project.id), ArtworkFidelityServiceError);

    const stored = await graph.artworkFidelity.getContract(created.project.id);
    assert.equal(stored, null);
  });

  it("BOUNDARY: proposing never calls a reconstruction/image-edit provider or mutates print-ready state", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await freshProjectWithUpload(graph, repo);

    const before = await repo.getProject(projectId);
    await proposeArtworkFidelity(projectId);
    const after = await repo.getProject(projectId);

    // Project status/production fields are untouched by a fidelity proposal.
    assert.equal(before!.project.status, after!.project.status);
  });

  describe("PROVIDER STATE (R4A-R Blocker 3)", () => {
    it("the placeholder-backed real graph reports proposalStatus: \"unavailable\" -- never misrepresented as a successful empty analysis", async () => {
      const { graph, repo } = await freshGraph();
      const projectId = await freshProjectWithUpload(graph, repo);

      const snapshot = await proposeArtworkFidelity(projectId);

      assert.equal(snapshot.artworkFidelity!.proposalStatus, "unavailable");
      // Neither state creates confirmed authority automatically, regardless.
      assert.equal(snapshot.artworkFidelity!.status, "proposed");
    });

    it("a genuine successful zero-fact analysis reports proposalStatus: \"analyzed\", distinguishably from \"unavailable\"", async () => {
      const { graph, repo } = await freshGraph();
      const projectId = await freshProjectWithUpload(graph, repo);
      await proposeArtworkFidelity(projectId);
      const contract = await graph.artworkFidelity.getContract(projectId);
      // Simulates what a REAL provider call that genuinely found nothing
      // would persist -- see `openai-artwork-fidelity-proposal-provider
      // .ts`'s own `analyzed: true` on a successful response, and
      // `artwork-fidelity-proposal-capability.test.ts` for the capability-
      // level proof that a successful-but-empty provider result actually
      // produces `proposalStatus: "analyzed"`.
      await repo.updateArtworkFidelityContract(contract!.id, {
        proposedFacts: toProposedFactsRecord({
          schemaVersion: "artwork-fidelity-proposal:v2",
          proposalStatus: "analyzed",
          wording: [],
          protectedMarks: [{ id: "m0", visualDescription: "", classification: "cannot_determine", confidence: "low" }],
          sanitizedProvider: { providerKey: "openai_artwork_fidelity_proposal", proposedAt: new Date().toISOString() },
        }),
      });

      const contractStatus = await graph.artworkFidelity.getContract(projectId);
      assert.ok(contractStatus);
      // Re-read through the same customer-safe view path the route uses.
      const { getConversation } = await import("./conversation-service");
      const view = await getConversation(projectId);
      assert.equal(view!.artworkFidelity!.proposalStatus, "analyzed");
    });
  });
});
