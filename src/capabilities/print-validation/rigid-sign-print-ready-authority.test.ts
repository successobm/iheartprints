import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RIGID_SIGN_REQUIRED_PRINT_READY_CHECK_CODES,
  isRigidSignValidationTrulyPrintReady,
} from "./rigid-sign-print-ready-authority";

/**
 * Sign Production Review Print-Ready Authority Repair: pure unit coverage
 * for the ONE authoritative "is this candidate truly print ready" function
 * — reused identically by the download authority
 * (`final-artwork-capability.ts`) and the operator review page's own
 * presentation-only peek (`sign-plan-operator-review.ts`).
 */
describe("isRigidSignValidationTrulyPrintReady", () => {
  function passingCheck(check: string) {
    return { check, status: "pass", severity: "blocking" };
  }

  function fullyPassingReport(): Record<string, unknown> {
    return { checks: RIGID_SIGN_REQUIRED_PRINT_READY_CHECK_CODES.map(passingCheck) };
  }

  it("every required check present and passing: true", () => {
    assert.equal(isRigidSignValidationTrulyPrintReady(fullyPassingReport()), true);
  });

  it("null/undefined report: false", () => {
    assert.equal(isRigidSignValidationTrulyPrintReady(null), false);
    assert.equal(isRigidSignValidationTrulyPrintReady(undefined), false);
  });

  it("report.checks is not an array: false", () => {
    assert.equal(isRigidSignValidationTrulyPrintReady({ checks: "not-an-array" }), false);
    assert.equal(isRigidSignValidationTrulyPrintReady({}), false);
  });

  it("a required check is MISSING ENTIRELY (the real historical Get Hibachi shape — physical_resolution_metadata never existed when the validation was written): false", () => {
    const report = fullyPassingReport();
    const checks = (report.checks as Array<Record<string, unknown>>).filter(
      (c) => c.check !== "physical_resolution_metadata",
    );
    assert.equal(isRigidSignValidationTrulyPrintReady({ checks }), false);
  });

  it("a required check is present but FAILING (blocking severity, non-pass status): false", () => {
    const report = fullyPassingReport();
    const checks = (report.checks as Array<Record<string, unknown>>).map((c) =>
      c.check === "content_within_bounds" ? { ...c, status: "fail" } : c,
    );
    assert.equal(isRigidSignValidationTrulyPrintReady({ checks }), false);
  });

  it("a required check is present but status 'unknown' (never resolved, incomplete computation): false", () => {
    const report = fullyPassingReport();
    const checks = (report.checks as Array<Record<string, unknown>>).map((c) =>
      c.check === "raster_dimensions_known" ? { ...c, status: "unknown" } : c,
    );
    assert.equal(isRigidSignValidationTrulyPrintReady({ checks }), false);
  });

  it("a required check present with severity 'warning' (e.g. machine_readable_content_preserved's accepted_as_supplied) and status 'warning': still true — a non-blocking severity never requires status 'pass'", () => {
    const report = fullyPassingReport();
    const checks = (report.checks as Array<Record<string, unknown>>).map((c) =>
      c.check === "machine_readable_content_preserved" ? { ...c, status: "warning", severity: "warning" } : c,
    );
    assert.equal(isRigidSignValidationTrulyPrintReady({ checks }), true);
  });

  it("extra, non-required check codes present alongside every required one: never interfere — still true", () => {
    const report = fullyPassingReport();
    const checks = [
      ...(report.checks as Array<Record<string, unknown>>),
      { check: "edge_intent_advisory", status: "pass", severity: "info" },
      { check: "resolution_provenance", status: "unknown", severity: "info" },
    ];
    assert.equal(isRigidSignValidationTrulyPrintReady({ checks }), true);
  });

  it("an entirely empty checks array: false", () => {
    assert.equal(isRigidSignValidationTrulyPrintReady({ checks: [] }), false);
  });
});
