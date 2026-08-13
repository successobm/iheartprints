import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveProductionRequirements } from "@/capabilities/print-validation/production-requirements";

import {
  resolveProductionWidth,
  resolveWidthConstrainedSizing,
  sizingPolicyForPlacement,
} from "./print-placement-dimensions";
import { describePrintReadySize } from "./print-ready-size";
import { detectProductionSizeIntent } from "./production-size-intent";

/**
 * Live Acceptance Cleanup — Issue 5: authoritative production size, and the
 * 300-DPI guarantee that has to hold at whatever size the customer chooses.
 *
 * Pure arithmetic and policy throughout — no repository, no provider, no
 * network, no paid call.
 */
describe("Production print size — defaults and derivation", () => {
  it("14: a standard adult full front defaults to 10.5\" wide", () => {
    const resolved = resolveProductionWidth("full_front", null);
    assert.equal(resolved!.widthIn, 10.5);
    assert.equal(resolved!.isDefault, true);

    const size = describePrintReadySize({
      printPlacement: "full_front",
      intendedPrintWidthIn: null,
      artworkWidthPx: 1024,
      artworkHeightPx: 1024,
    });
    assert.equal(size!.widthIn, 10.5);
    assert.equal(size!.dpi, 300);
    assert.equal(size!.placementLabel, "Full Front");
    assert.match(size!.note!, /standard adult full front print size/i);
  });

  it("15: a standard adult full back defaults to 10.5\" wide", () => {
    assert.equal(resolveProductionWidth("full_back", null)!.widthIn, 10.5);
    const size = describePrintReadySize({
      printPlacement: "full_back",
      intendedPrintWidthIn: null,
      artworkWidthPx: 1024,
      artworkHeightPx: 1024,
    });
    assert.equal(size!.widthIn, 10.5);
    assert.equal(size!.dpi, 300);
  });

  it("16: height derives from the artwork's own aspect ratio, not a fixed canvas", () => {
    const square = describePrintReadySize({
      printPlacement: "full_front",
      intendedPrintWidthIn: null,
      artworkWidthPx: 1000,
      artworkHeightPx: 1000,
    });
    assert.equal(square!.heightIn, 10.5);

    // A taller artwork produces a taller print at the same width.
    const tall = describePrintReadySize({
      printPlacement: "full_front",
      intendedPrintWidthIn: null,
      artworkWidthPx: 1000,
      artworkHeightPx: 1070,
    });
    assert.ok(tall!.heightIn! > 11.2 - 0.05 && tall!.heightIn! < 11.2 + 0.05);

    // Unknown proportions are reported as unknown, never guessed.
    const unknown = describePrintReadySize({
      printPlacement: "full_front",
      intendedPrintWidthIn: null,
      artworkWidthPx: null,
      artworkHeightPx: null,
    });
    assert.equal(unknown!.heightIn, null);
  });

  it("17: the customer can choose a larger width, and it is offered as a choice", () => {
    const resolved = resolveProductionWidth("full_front", 12);
    assert.equal(resolved!.widthIn, 12);
    assert.equal(resolved!.isDefault, false);
    assert.equal(resolved!.clamped, false);

    const size = describePrintReadySize({
      printPlacement: "full_front",
      intendedPrintWidthIn: 12,
      artworkWidthPx: 1000,
      artworkHeightPx: 1000,
    });
    assert.equal(size!.widthIn, 12);
    assert.equal(size!.isDefaultWidth, false);
    assert.equal(size!.heightIn, 12, "height scales with the chosen width");
    assert.deepEqual(
      size!.widthOptions.map((option) => option.widthIn),
      [9, 10.5, 12],
    );
    assert.equal(
      size!.widthOptions.find((option) => option.isStandard)!.widthIn,
      10.5,
    );
    assert.equal(
      size!.widthOptions.find((option) => option.isSelected)!.widthIn,
      12,
    );
  });

  it("17b: a request outside the printable band is clamped honestly, never silently honored", () => {
    const tooBig = resolveProductionWidth("full_front", 30);
    assert.equal(tooBig!.widthIn, 14);
    assert.equal(tooBig!.clamped, true);

    const tooSmall = resolveProductionWidth("full_front", 0.5);
    assert.equal(tooSmall!.widthIn, 4);
    assert.equal(tooSmall!.clamped, true);
  });

  it("18: the chosen width becomes the production sizing policy the pipeline uses", () => {
    const requirements = deriveProductionRequirements({
      printPlacement: "full_front",
      productSummary: "a crewneck t-shirt",
      designDescription: "a bowling badge",
      intendedPrintWidthIn: 12,
    });

    assert.equal(requirements.sizing!.targetWidthIn, 12);
    assert.equal(requirements.sizing!.targetPpi, 300);
    assert.equal(requirements.targetDimensions!.widthIn, 12);
    // Never inferred from pixels: with no choice recorded, the default holds.
    const defaulted = deriveProductionRequirements({
      printPlacement: "full_front",
      productSummary: "a crewneck t-shirt",
      designDescription: "a bowling badge",
      intendedPrintWidthIn: null,
    });
    assert.equal(defaulted.sizing!.targetWidthIn, 10.5);
  });
});

describe("Production print size — 300 DPI guarantee", () => {
  it("20: a 12\" width requires 3600 px at 300 DPI", () => {
    const policy = sizingPolicyForPlacement("full_front", 12)!;
    const resolution = resolveWidthConstrainedSizing(policy, 1000, 1000);

    assert.equal(resolution.widthPx, 3600);
    assert.equal(resolution.widthIn, 12);
    assert.equal(resolution.targetPpi, 300);
    assert.equal(resolution.widthPx / resolution.widthIn, 300);
  });

  it("20b: the standard 10.5\" width requires 3150 px at 300 DPI", () => {
    const policy = sizingPolicyForPlacement("full_front", null)!;
    const resolution = resolveWidthConstrainedSizing(policy, 1000, 1000);

    assert.equal(resolution.widthPx, 3150);
    assert.equal(resolution.widthIn, 10.5);
    assert.equal(resolution.widthPx / resolution.widthIn, 300);
  });

  it("20c: effective resolution is 300 PPI at every offered width — never quietly lower", () => {
    for (const widthIn of [9, 10.5, 12, 14]) {
      const policy = sizingPolicyForPlacement("full_front", widthIn)!;
      // A deliberately non-square artwork, so height rounding is exercised too.
      const resolution = resolveWidthConstrainedSizing(policy, 1024, 1280);
      assert.equal(
        resolution.widthPx / resolution.widthIn,
        300,
        `width PPI must be exactly 300 at ${widthIn}in`,
      );
      assert.ok(
        Math.abs(resolution.heightPx / resolution.heightIn - 300) < 1e-9,
        `height PPI must be 300 at ${widthIn}in`,
      );
    }
  });
});

describe("Production size intent — a size change is not a creative revision", () => {
  it("recognizes an explicit width in ordinary language", () => {
    assert.deepEqual(detectProductionSizeIntent("Make it 12 inches wide."), {
      kind: "absolute",
      widthIn: 12,
    });
    assert.deepEqual(
      detectProductionSizeIntent("can you make the print 9.5 inches wide?"),
      { kind: "absolute", widthIn: 9.5 },
    );
    assert.deepEqual(detectProductionSizeIntent('print it at 11" please'), {
      kind: "absolute",
      widthIn: 11,
    });
  });

  it("recognizes a relative size change only when the customer named the print", () => {
    assert.deepEqual(detectProductionSizeIntent("make the print a little smaller"), {
      kind: "relative",
      direction: "smaller",
    });
    assert.deepEqual(detectProductionSizeIntent("can the design be bigger?"), {
      kind: "relative",
      direction: "larger",
    });
  });

  it("never hijacks a creative revision", () => {
    // These are instructions about the ARTWORK and must keep flowing to the
    // revision pipeline — mistaking one for a resize would silently drop the
    // change the customer asked for.
    for (const creative of [
      "make it smaller",
      "make the car larger",
      "make the wheels chrome",
      "shrink the badge",
      "make the 3 SONS text the same color as the ball",
      "use a bolder font",
    ]) {
      assert.equal(
        detectProductionSizeIntent(creative),
        null,
        `"${creative}" is a creative revision, not a production-size change`,
      );
    }
  });
});
