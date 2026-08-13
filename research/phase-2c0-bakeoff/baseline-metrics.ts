import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { evaluatePrintPaletteCompliance } from "../../src/capabilities/concept-evaluation/print-palette-compliance";

const brief = {
  productSummary: "T-shirt",
  designDescription: "A 2005 Harley Road Glide in black with silver trim",
  exactText: "",
  shirtColor: "Black",
  printPlacement: "full_back" as const,
  preferredColors: ["White"],
  designStyle: null,
  additionalInstructions: null,
  audience: null,
  purpose: null,
  exclusions: null,
  deferredSections: [] as string[],
};

for (const name of ["bold_direct", "soft_illustrated", "minimal_badge"]) {
  const png = PNG.sync.read(readFileSync(`.tmp-phase2b-harley/${name}.png`));
  const r = evaluatePrintPaletteCompliance({
    brief,
    image: { width: png.width, height: png.height, data: Buffer.from(png.data) },
  });
  console.log(
    JSON.stringify({
      baseline: name,
      status: r.status,
      coverage: Number(r.metrics.paletteCoverageFraction.toFixed(4)),
      garmentMatch: Number(r.metrics.garmentMatchingFraction.toFixed(4)),
      reasons: r.reasons,
    }),
  );
}
