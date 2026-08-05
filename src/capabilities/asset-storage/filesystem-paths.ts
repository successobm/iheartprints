import path from "path";

/**
 * Sprint 2H Part 2A: shared by `FilesystemAssetStorageProvider` and the
 * `/api/assets/[...objectKey]` route that serves signed-URL requests, so
 * both agree on exactly one base directory and one traversal guard.
 */

export function assetsBaseDir(): string {
  return path.join(process.cwd(), ".data", "assets");
}

/**
 * Decodes and validates an object key so it cannot escape the assets root.
 * Rejects absolute paths, Windows/UNC forms, `.` / `..` segments, backslashes,
 * null bytes, and percent-encoded variants of the same (including nested
 * encoding such as `%252e%252e%252f`).
 *
 * Legitimate keys look like:
 * `projects/{projectId}/concepts/{conceptId}/original.png`
 */
export function normalizeObjectKey(objectKey: string): string {
  if (typeof objectKey !== "string" || objectKey.length === 0) {
    throw new Error("Invalid asset object key");
  }

  // Iteratively decode to defeat single- and multi-level percent-encoding.
  let decoded = objectKey;
  for (let i = 0; i < 4; i++) {
    if (decoded.includes("\0")) {
      throw new Error("Invalid asset object key");
    }
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new Error("Invalid asset object key");
    }
    if (next === decoded) break;
    decoded = next;
  }

  // After full decode, reject separators and absolute / UNC / drive forms.
  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    /^[a-zA-Z]:/.test(decoded)
  ) {
    throw new Error("Invalid asset object key");
  }

  const segments = decoded.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Invalid asset object key");
  }

  // Conservative charset matching the keys `buildObjectKey` produces.
  const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
  if (!segments.every((segment) => SAFE_SEGMENT.test(segment))) {
    throw new Error("Invalid asset object key");
  }

  return segments.join("/");
}

/** Resolves an object key to an on-disk path, rejecting any attempt to escape the assets directory. */
export function resolveAssetPath(objectKey: string): string {
  const normalized = normalizeObjectKey(objectKey);
  const base = path.resolve(assetsBaseDir());
  const resolved = path.resolve(base, ...normalized.split("/"));
  const relative = path.relative(base, resolved);

  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    (resolved !== base && !resolved.startsWith(base + path.sep))
  ) {
    throw new Error("Invalid asset object key");
  }

  return resolved;
}

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

export function contentTypeForObjectKey(objectKey: string): string {
  const ext = path.extname(objectKey).toLowerCase();
  return EXTENSION_CONTENT_TYPES[ext] ?? "application/octet-stream";
}
