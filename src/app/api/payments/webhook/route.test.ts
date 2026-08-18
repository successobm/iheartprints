import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Sprint A5.4 — the webhook route's SHAPE, asserted against its own source.
 *
 * Behaviour is proved end to end in
 * `capabilities/payment/production-unlock-webhook.test.ts`, which drives raw
 * bodies and real signatures through the real adapter. What that suite cannot
 * assert is the handful of properties that live in the route module itself and
 * are invisible from the outside — reading the body exactly once, never
 * parsing it, and never reaching for a cookie, a project id, or a query
 * parameter.
 *
 * Those are structural claims about code, so they are checked as such. A
 * source-level assertion is a blunt instrument and is used deliberately
 * narrowly: each one below corresponds to a specific way this endpoint would
 * become unsafe, and would otherwise be caught by nothing.
 */

const ROUTE_PATH = path.join(
  process.cwd(),
  "src/app/api/payments/webhook/route.ts",
);

function routeSource(): string {
  return readFileSync(ROUTE_PATH, "utf8");
}

/** Strips line and block comments so prose about a rule is never mistaken for the rule. */
function executableSource(): string {
  return routeSource()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("Sprint A5.4 — payment webhook route", () => {
  it("A: reads the raw body EXACTLY once", () => {
    const source = executableSource();
    const reads = source.match(/request\.text\(\)/g) ?? [];
    assert.equal(
      reads.length,
      1,
      "the body stream can only be consumed once; a second read would throw or return empty",
    );
    // `.json()` would both consume the stream and parse it — the two things
    // this route must not do.
    assert.equal(source.includes("request.json("), false);
  });

  it("B: never parses the body — the signature covers BYTES, not meaning", () => {
    const source = executableSource();
    assert.equal(
      source.includes("JSON.parse"),
      false,
      "parsing here would interpret attacker-supplied structure before verifying it came from the provider",
    );
  });

  it("C: takes no project id, no cookie, and no query parameter", () => {
    const source = executableSource();
    for (const forbidden of [
      "projectId",
      "params",
      "cookies",
      "searchParams",
      "acquisitionSession",
      "readAcquisitionSessionToken",
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `the webhook must not reference ${forbidden} — a payment provider has none, and a browser must not be able to reach this path with an identity`,
      );
    }
  });

  it("D: is POST-only — no GET handler that a browser could navigate to", () => {
    const source = executableSource();
    assert.match(source, /export async function POST\(/);
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD"]) {
      assert.equal(
        new RegExp(`export (async )?function ${method}\\(`).test(source),
        false,
        `${method} must not be exported`,
      );
    }
  });

  it("E: sets cache-control no-store on every response path", () => {
    const source = executableSource();
    const responses = source.match(/status,?\s*$|NextResponse\.json\(/g) ?? [];
    assert.ok(responses.length > 0);
    // One helper builds every response, and it sets the header — so the claim
    // is that no response is constructed outside it.
    assert.equal(
      (source.match(/NextResponse\.json\(/g) ?? []).length,
      1,
      "every response must go through the single helper that sets no-store",
    );
    assert.match(source, /"cache-control":\s*"no-store"/);
  });

  it("F: never echoes provider detail, an outcome, or an internal id in the body", () => {
    const source = executableSource();
    // The only response shape is `{ received: boolean }`.
    const bodies = [...source.matchAll(/json\(\{([^}]*)\}/g)].map((m) => m[1]!.trim());
    assert.ok(bodies.length >= 3, "expected the success, reject, and error bodies");
    for (const body of bodies) {
      assert.match(
        body,
        /^received:\s*(true|false)$/,
        `response body must be exactly { received } — found: ${body}`,
      );
    }
    // Telling the caller what was decided would leak whether a transaction id
    // exists, which is precisely what a prober wants.
    for (const leak of ["outcome", "paymentTransactionId", "providerEventId", "checkoutUrl"]) {
      assert.equal(
        source.includes(`${leak}:`),
        false,
        `${leak} must never appear in a response body`,
      );
    }
  });

  it("G: answers 400 for an unverified request and 500 only for an infrastructure fault", () => {
    const source = executableSource();
    // 400 = we could not establish this came from the provider.
    assert.match(source, /received:\s*false\s*\},\s*400/);
    // 200 = verified and decided, including the refusals — otherwise a
    // permanent refusal becomes an infinite provider retry loop.
    assert.match(source, /received:\s*true\s*\},\s*200/);
    // 500 = the event was real; the provider SHOULD retry.
    assert.match(source, /received:\s*false\s*\},\s*500/);
  });

  it("H: never logs the body, the signature, or an error message", () => {
    const source = executableSource();
    const logs = [...source.matchAll(/console\.\w+\(([^;]*)\)/g)].map((m) => m[1]!);
    for (const call of logs) {
      for (const forbidden of ["rawBody", "signatureHeader", "error.message", "error)"]) {
        assert.equal(
          call.includes(forbidden),
          false,
          `a log must not carry ${forbidden}: ${call.trim()}`,
        );
      }
    }
  });
});
