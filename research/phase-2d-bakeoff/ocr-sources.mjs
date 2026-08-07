import fs from "node:fs";
import path from "node:path";

function loadDotEnvLocal() {
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const n = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!process.env[n]) process.env[n] = v;
  }
}

function normalize(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matches(required, detected) {
  const n = normalize(required);
  return !n || n === normalize(detected);
}

async function ocr(file, required) {
  const bytes = fs.readFileSync(file);
  const b64 = bytes.toString("base64");
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_EVALUATION_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                'Read the exact wording printed in this apparel logo artwork. Return JSON only: {"detectedText": string, "confidence": number 0-100, "notes": string}. ' +
                `Required wording for comparison (do not invent): "${required}". ` +
                "If multiple text regions, concatenate in reading order with spaces.",
            },
            {
              type: "input_image",
              image_url: `data:image/png;base64,${b64}`,
            },
          ],
        },
      ],
      text: { format: { type: "json_object" } },
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    return { file: path.basename(file), error: JSON.stringify(json).slice(0, 300) };
  }
  const text = json.output_text || "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { detectedText: text };
  }
  const detected = String(parsed.detectedText || "");
  return {
    file: path.basename(file),
    detected,
    confidence: parsed.confidence ?? null,
    matches: matches(required, detected),
    notes: parsed.notes ?? null,
  };
}

loadDotEnvLocal();
const required = "My 3 Sons";
const files = [
  "research/phase-2d-bakeoff/sources/A_typography__bold_direct_my3sons.png",
  "research/phase-2d-bakeoff/sources/B_illustrated__soft_illustrated_my3sons.png",
  "research/phase-2d-bakeoff/sources/C_transparent__minimal_badge_my3sons.png",
];
for (const f of files) {
  console.log(JSON.stringify(await ocr(f, required)));
}
