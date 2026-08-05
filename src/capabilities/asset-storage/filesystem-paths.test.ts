import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { normalizeObjectKey, resolveAssetPath } from "./filesystem-paths";

/**
 * Path-traversal rejections for the filesystem asset root
 * (Sprint 2H Part 2A Security Check 2).
 */
const TRAVERSAL_KEYS = [
  "../secret",
  "..%2Fsecret",
  "%2e%2e%2fsecret",
  "%252e%252e%252fsecret",
  "..\\secret",
  "..%5Csecret",
  "%2e%2e%5csecret",
  "C:\\Windows\\system.ini",
  "/C:/Windows/system.ini",
  "/etc/passwd",
  "\\\\server\\share\\file",
  "projects/abc/../../secret",
  "projects%2Fabc%2F..%2F..%2Fsecret",
] as const;

describe("filesystem object-key traversal guard", () => {
  for (const objectKey of TRAVERSAL_KEYS) {
    it(`rejects ${JSON.stringify(objectKey)}`, () => {
      assert.throws(() => normalizeObjectKey(objectKey), /Invalid asset object key/);
      assert.throws(() => resolveAssetPath(objectKey), /Invalid asset object key/);
    });
  }

  it("accepts the shared projects/.../concepts/... object-key convention", () => {
    const key = "projects/project-1/concepts/concept-1/original.png";
    assert.equal(normalizeObjectKey(key), key);
    const resolved = resolveAssetPath(key);
    assert.ok(resolved.endsWith(path.join("projects", "project-1", "concepts", "concept-1", "original.png")));
  });
});
