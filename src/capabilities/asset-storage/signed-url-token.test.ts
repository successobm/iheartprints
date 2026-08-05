import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

describe("signed-url-token", () => {
  const originalSecret = process.env.ASSET_SIGNING_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.ASSET_SIGNING_SECRET;
    else process.env.ASSET_SIGNING_SECRET = originalSecret;
  });

  it("verifies a token it just signed, for the same object key and expiry", async () => {
    const { signAssetToken, verifyAssetToken } = await import("./signed-url-token");
    const expiresAtMs = Date.now() + 60_000;
    const token = signAssetToken("projects/p1/concepts/c1/original.png", expiresAtMs);
    assert.equal(
      verifyAssetToken("projects/p1/concepts/c1/original.png", expiresAtMs, token),
      true,
    );
  });

  it("rejects a token whose expiry has already passed", async () => {
    const { signAssetToken, verifyAssetToken } = await import("./signed-url-token");
    const expiresAtMs = Date.now() - 1000;
    const token = signAssetToken("projects/p1/concepts/c1/original.png", expiresAtMs);
    assert.equal(
      verifyAssetToken("projects/p1/concepts/c1/original.png", expiresAtMs, token),
      false,
    );
  });

  it("rejects a token issued for a different object key", async () => {
    const { signAssetToken, verifyAssetToken } = await import("./signed-url-token");
    const expiresAtMs = Date.now() + 60_000;
    const token = signAssetToken("projects/p1/concepts/c1/original.png", expiresAtMs);
    assert.equal(
      verifyAssetToken("projects/p1/concepts/c2/original.png", expiresAtMs, token),
      false,
    );
  });

  it("rejects a tampered token", async () => {
    const { signAssetToken, verifyAssetToken } = await import("./signed-url-token");
    const expiresAtMs = Date.now() + 60_000;
    const token = signAssetToken("projects/p1/concepts/c1/original.png", expiresAtMs);
    const tampered = token.slice(0, -2) + (token.endsWith("00") ? "ff" : "00");
    assert.equal(
      verifyAssetToken("projects/p1/concepts/c1/original.png", expiresAtMs, tampered),
      false,
    );
  });

  it("rejects a malformed (non-hex) token instead of throwing", async () => {
    const { verifyAssetToken } = await import("./signed-url-token");
    assert.equal(
      verifyAssetToken("projects/p1/concepts/c1/original.png", Date.now() + 60_000, "not-hex!!"),
      false,
    );
  });

  it("produces different signatures under different secrets", async () => {
    process.env.ASSET_SIGNING_SECRET = "secret-one";
    const { signAssetToken: signWithOne } = await import("./signed-url-token");
    const expiresAtMs = Date.now() + 60_000;
    const tokenOne = signWithOne("projects/p1/concepts/c1/original.png", expiresAtMs);

    process.env.ASSET_SIGNING_SECRET = "secret-two";
    // Force a fresh module evaluation isn't possible for a cached ESM import,
    // so verify cross-secret rejection via direct HMAC comparison instead:
    // re-importing the same module still uses whichever secret is read at
    // call time (the function reads process.env on every call, not once).
    const { verifyAssetToken } = await import("./signed-url-token");
    assert.equal(
      verifyAssetToken("projects/p1/concepts/c1/original.png", expiresAtMs, tokenOne),
      false,
    );
  });
});
