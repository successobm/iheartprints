export {
  createFinalArtworkCapability,
  type FinalArtworkCapability,
  type RequestFinalArtworkResult,
} from "./final-artwork-capability";
export type { FinalArtworkInput } from "./contracts";
export type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
  FinalArtworkProviderResumeContext,
} from "./provider";
export { LocalRasterInterpolationProvider } from "./local-raster-provider";
export {
  TopazTransparencyUpscaleProvider,
  type TopazTransparencyUpscaleProviderConfig,
} from "./topaz-transparency-upscale-provider";
export { UnavailableFinalArtworkProvider } from "./unavailable-final-artwork-provider";
export {
  FinalArtworkUnavailableError,
  type FinalArtworkUnavailableSafeErrorCode,
} from "./final-artwork-unavailable-error";
export { resolveFinalArtworkProvider } from "./resolve-final-artwork-provider";
export {
  resampleExact,
  hasAnyTransparentPixel,
  type RgbaImage,
  type ResampleResult,
} from "./raster-transform";
export {
  trimToAlphaBounds,
  computeAlphaBounds,
  safetyMarginPxFor,
  DEFAULT_ALPHA_THRESHOLD,
  MIN_SAFETY_MARGIN_PX,
  SAFETY_MARGIN_FRACTION,
  type AlphaTrimOutcome,
  type AlphaTrimMetadata,
  type AlphaBoundingBox,
} from "./alpha-trim";
export {
  normalizeProductionRaster,
  encodeProductionPng,
  type ProductionSizingRequest,
  type ProductionNormalizationMetadata,
  type NormalizedProductionRaster,
  type NormalizeProductionRasterOutcome,
} from "./production-normalization";
export {
  withPhysicalPixelDensity,
  readPhysicalPixelDensity,
  pixelsPerMetreForPpi,
  ppiFromPixelsPerMetre,
  type PhysicalPixelDensity,
} from "./production-png";
