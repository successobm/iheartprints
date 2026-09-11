export {
  createArtworkFidelityProposalCapability,
  sha256Hex,
  type ArtworkFidelityProposalCapability,
  type ArtworkFidelityProposalInput,
} from "./artwork-fidelity-proposal-capability";
export { resolveArtworkFidelityProposalProvider } from "./resolve-artwork-fidelity-proposal-provider";
export { downscaleForProposal, MAX_PROPOSAL_DIMENSION_PX } from "./downscale-for-proposal";
export {
  ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION,
  isArtworkFidelityProposedFacts,
  toProposedFactsRecord,
  type ArtworkFidelityProposedFacts,
  type ArtworkFidelityProposalResult,
  type MarkClassificationProposal,
  type ProposalAnalysisStatus,
  type ProposalConfidence,
  type ProtectedMarkFactProposal,
  type RawProtectedMarkFactProposal,
  type RawWordingFactProposal,
  type WordingFactProposal,
  type WordingReadability,
} from "./contracts";
export type { ArtworkFidelityProposalProvider, ArtworkFidelityProposalImageInput } from "./artwork-fidelity-proposal-provider";
