import fs from "node:fs";

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

loadDotEnvLocal();
const key = process.env.TOPAZ_API_KEY;
if (!key) {
  console.log(JSON.stringify({ error: "missing key" }));
  process.exit(1);
}

const res = await fetch("https://api.topazlabs.com/account/v1/credits/balance", {
  headers: { "X-API-Key": key },
});
const text = await res.text();
console.log(JSON.stringify({ status: res.status, body: text.slice(0, 500), keyLen: key.length }));
