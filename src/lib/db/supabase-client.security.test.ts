import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  getSupabaseServiceClient,
  inspectSupabaseCredentials,
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
 * No real credential appears anywhere in this file. The values below are
 * obvious non-secrets, and the tests only assert on which VARIABLE the
 * client demands.
 */

const ORIGINAL_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};

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
  it("is configured only when both the URL and the service role key are present", () => {
    assert.equal(
      inspectSupabaseCredentials({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
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
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-must-not-suffice",
      }),
      "misconfigured_missing_service_role",
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

describe("getSupabaseServiceClient", () => {
  // G
  it("refuses to fall back to the anon key when the service role key is missing", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-must-not-suffice";

    assert.throws(getSupabaseServiceClient, /SUPABASE_SERVICE_ROLE_KEY/);
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
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

    assert.throws(getSupabaseServiceClient, /NEXT_PUBLIC_SUPABASE_URL/);
  });

  // H
  it("still constructs a client when correctly configured", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

    const client = getSupabaseServiceClient();

    assert.ok(client);
    assert.equal(typeof client.from, "function");
    assert.ok(isSupabaseConfigured());
  });

  it("does not report itself configured on an anon key alone", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-must-not-suffice";

    assert.equal(isSupabaseConfigured(), false);
  });
});
