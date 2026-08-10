/**
 * Customer-facing download filename for print-ready production artwork.
 * Pure and side-effect-free — never includes UUIDs, storage paths, or
 * provider/job identifiers.
 */

const FALLBACK_BASENAME = "print-ready-artwork";

/**
 * Builds a filesystem-safe `…-print-ready.png` (or other extension) name
 * from customer-facing wording / product summary.
 */
export function buildPrintReadyFilename(input: {
  exactText?: string | null;
  productSummary?: string | null;
  mimeType?: string | null;
}): string {
  const extension = extensionForMimeType(input.mimeType);
  const raw = (input.exactText?.trim() || input.productSummary?.trim() || "").trim();
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

function extensionForMimeType(mimeType: string | null | undefined): string {
  const normalized = (mimeType ?? "").toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/webp") return "webp";
  return "png";
}
