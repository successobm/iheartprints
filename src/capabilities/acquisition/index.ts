export {
  createAcquisitionCapability,
  type AcquisitionCapability,
  type ConceptGenerationAuthorization,
  type CustomerAcquisitionState,
  type CustomerAcquisitionView,
  type EmailCaptureResult,
  type FinalizationAuthorization,
} from "./acquisition-capability";
export {
  ACQUISITION_UNAVAILABLE_MESSAGE,
  EMAIL_PURPOSE_NOTE,
  EMAIL_REQUIRED_CONVERSATION_MESSAGE,
  EMAIL_REQUIRED_HEADLINE,
  EMAIL_REQUIRED_MESSAGE,
  EMAIL_SUBMIT_LABEL,
  FREE_CONCEPT_SPENT_MESSAGE,
  FREE_CONCEPT_WAITING_MESSAGE,
  PAID_FINALIZATION_LOCKED_MESSAGE,
  PAID_GENERATION_LOCKED_MESSAGE,
} from "./acquisition-copy";
export {
  MAX_EMAIL_LENGTH,
  normalizeEmail,
  validateEmail,
  type EmailValidationResult,
} from "./acquisition-email";
