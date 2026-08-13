import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  getSupabaseServiceClient,
  inspectSupabaseCredentials,
  inspectSupabaseKeyAuthority,
  isSupabaseConfigured,
} from "./supabase-client";

/**
 * Server-Only RLS Lockdown, requirements G and H: the privileged repository
 * client must never silently downgrade to a browser-facing key.
 *
 * With RLS enabled and no policies, an anon-keyed client cannot read a
 * single application row — so the old `SUPABASE_SERVICE_ROLE_KEY ??
 * NEXT_PUBLIC_SUPABASE_ANON_KEY` fallback would now produce a server that
 * fails every query while reporting itself as configured.
 *
 * A correctly *named* `SUPABASE_SERVICE_ROLE_KEY` whose JWT `role` is
 * `anon` is the same failure: Postgres reports `42501` / role `anon`. The
 * factory must refuse that value before any query is sent.
 *
 * No real credential appears anywhere in this file. The values below are
 * obvious non-secrets, and the tests only assert on which VARIABLE the
 * client demands and which authority label it reports.
 */

const ORIGINAL_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};

function unsignedJwt(role: string): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ role, iss: "supabase" })}.sig`;
}

const SERVICE_ROLE_JWT = unsignedJwt("service_role");
const ANON_JWT = unsignedJwt("anon");
const AUTHENTICATED_JWT = unsignedJwt("authenticated");

function restoreEnv() {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

afterEach(restoreEnv);

describe("supabase credential inspection", () => {
  it("is configured only when both the URL and a service-role key are present", () => {
    assert.equal(
      inspectSupabaseCredentials({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_JWT,
      }),
      "configured",
    );
  });

  it("treats a bare URL with no service role key as MISCONFIGURED, not unconfigured", () => {
    assert.equal(
      inspectSupabaseCredentials({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      }),
      "misconfigured_missing_service_role",
    );
  });

  it("does not accept an anon key as a substitute for the service role key", () => {
    assert.equal(
      inspectSupabaseCredentials({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_JWT,
      }),
      "misconfigured_missing_service_role",
    );
  });

  it("treats a present SUPABASE_SERVICE_ROLE_KEY whose JWT role is anon as wrong authority", () => {
    assert.equal(
      inspectSupabaseCredentials({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: ANON_JWT,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_JWT,
      }),
      "misconfigured_wrong_authority",
    );
  });

  it("reports an entirely empty environment as unconfigured, preserving local development", () => {
    assert.equal(inspectSupabaseCredentials({}), "unconfigured");
  });

  it("treats whitespace-only values as absent", () => {
    assert.equal(
      inspectSupabaseCredentials({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "   ",
      }),
      "misconfigured_missing_service_role",
    );
  });
});

describe("inspectSupabaseKeyAuthority", () => {
  it("reads service_role from a JWT role claim", () => {
    assert.equal(inspectSupabaseKeyAuthority(SERVICE_ROLE_JWT), "service_role");
  });

  it("reads anon from a JWT role claim", () => {
    assert.equal(inspectSupabaseKeyAuthority(ANON_JWT), "anon");
  });

  it("reads authenticated from a JWT role claim", () => {
    assert.equal(
      inspectSupabaseKeyAuthority(AUTHENTICATED_JWT),
      "authenticated",
    );
  });

  it("treats sb_secret_ keys as service_role", () => {
    assert.equal(
      inspectSupabaseKeyAuthority("sb_secret_not-a-real-secret"),
      "service_role",
    );
  });

  it("treats sb_publishable_ keys as publishable, never service_role", () => {
    assert.equal(
      inspectSupabaseKeyAuthority("sb_publishable_not-a-real-key"),
      "publishable",
    );
  });

  it("does not treat an arbitrary string as service_role", () => {
    assert.equal(inspectSupabaseKeyAuthority("service-role-key"), "unrecognized");
  });
});

describe("getSupabaseServiceClient", () => {
  // G
  it("refuses to fall back to the anon key when the service role key is missing", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_JWT;

    assert.throws(getSupabaseServiceClient, /SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("refuses a SUPABASE_SERVICE_ROLE_KEY whose JWT role is anon", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = ANON_JWT;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_JWT;

    assert.throws(getSupabaseServiceClient, /observed: anon/);
  });

  it("names only the authority label, never a credential value", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = ANON_JWT;

    assert.throws(getSupabaseServiceClient, (error: Error) => {
      assert.ok(
        !error.message.includes(ANON_JWT),
        "error message leaked a credential value",
      );
      assert.match(error.message, /observed: anon/);
      return true;
    });
  });

  it("names only the missing variable, never a credential value", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-must-not-suffice";

    assert.throws(getSupabaseServiceClient, (error: Error) => {
      assert.ok(
        !error.message.includes("anon-key-must-not-suffice"),
        "error message leaked a credential value",
      );
      return true;
    });
  });

  it("fails clearly when the URL itself is missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_JWT;

    assert.throws(getSupabaseServiceClient, /NEXT_PUBLIC_SUPABASE_URL/);
  });

  // H
  it("still constructs a client when correctly configured", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_JWT;

    const client = getSupabaseServiceClient();

    assert.ok(client);
    assert.equal(typeof client.from, "function");
    assert.ok(isSupabaseConfigured());
  });

  it("does not report itself configured on an anon key alone", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_JWT;

    assert.equal(isSupabaseConfigured(), false);
  });

  it("does not report itself configured when the service-role variable holds an anon JWT", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = ANON_JWT;

    assert.equal(isSupabaseConfigured(), false);
  });
});
