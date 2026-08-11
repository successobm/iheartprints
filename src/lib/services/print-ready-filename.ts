/**
 * Customer-facing download filename for print-ready production artwork.
 * Pure and side-effect-free — never includes UUIDs, storage paths, or
 * provider/job identifiers.
 */

const FALLBACK_BASENAME = "print-ready-artwork";

/**
 * Builds a filesystem-safe `…-print-ready.png` (or other extension) name.
 *
 * Precedence, highest first:
 *
 *   1. `uploadedFilename` — the name the CUSTOMER gave their own artwork
 *      (Existing Artwork → Print Ready Phase 2). For an uploaded file this
 *      beats every brief-derived option, and by a wide margin: they will
 *      recognize `split-disturbers-print-ready.png` immediately, whereas the
 *      only brief text an upload project ever has is the production context
 *      they typed ("T-shirts for our bowling team") — which describes the
 *      garment, not the design.
 *   2. `exactText` — the required wording of a generated design.
 *   3. `productSummary` — what they said they were printing.
 *
 * Any extension on `uploadedFilename` is dropped: this file is a different
 * deliverable from what they uploaded, and carrying `.jpg` onto a PNG would
 * be wrong in the one way a filename can actually mislead.
 */
export function buildPrintReadyFilename(input: {
  exactText?: string | null;
  productSummary?: string | null;
  mimeType?: string | null;
  /** Sanitized original upload filename, when this project's artwork came from the customer. */
  uploadedFilename?: string | null;
}): string {
  const extension = extensionForMimeType(input.mimeType);
  const raw = (
    stripFileExtension(input.uploadedFilename) ||
    input.exactText?.trim() ||
    input.productSummary?.trim() ||
    ""
  ).trim();
  if (!raw) {
    return `${FALLBACK_BASENAME}.${extension}`;
  }
  const slug = slugifyFilenameBase(raw) || FALLBACK_BASENAME;
  if (slug === FALLBACK_BASENAME) {
    return `${FALLBACK_BASENAME}.${extension}`;
  }
  const base = slug.endsWith("-print-ready") ? slug : `${slug}-print-ready`;
  return `${base}.${extension}`;
}

export function slugifyFilenameBase(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80)
    .replace(/-+$/g, "")
    .toLowerCase();
}

/** `"3 sons bowling logo.png"` → `"3 sons bowling logo"`. A name that is nothing but an extension yields `""`. */
function stripFileExtension(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/\.[a-z0-9]{1,8}$/i, "").trim();
}

function extensionForMimeType(mimeType: string | null | undefined): string {
  const normalized = (mimeType ?? "").toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/webp") return "webp";
  return "png";
}
