import fs from "node:fs";

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
  process.env[n] = v;
}

const pid = "e85242d5-3607-4fa1-b6dd-00e8e46800d5";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function q(p) {
  const r = await fetch(`${url}/rest/v1/${p}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  return r.json();
}

const creditsRes = await fetch(
  "https://api.topazlabs.com/account/v1/credits/balance",
  { headers: { "X-API-Key": process.env.TOPAZ_API_KEY } },
);
const credits = await creditsRes.json();
const jobs = await q(
  `final_artwork_jobs?project_id=eq.${pid}&select=id,status,provider_request_id,provider_key,created_at`,
);
const prod = await q(
  `assets?project_id=eq.${pid}&production_role=eq.production_png&select=id,created_at`,
);
const vals = await q(
  `production_asset_validations?project_id=eq.${pid}&select=id,created_at`,
);

console.log(
  JSON.stringify(
    {
      credits,
      jobs: jobs.length,
      jobRequestIds: jobs.map((j) => j.provider_request_id),
      prod: prod.length,
      vals: vals.length,
    },
    null,
    2,
  ),
);
