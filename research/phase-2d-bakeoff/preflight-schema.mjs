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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const res = await fetch(`${url}/rest/v1/`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});
const text = await res.text();
const tables = [
  "final_artwork_jobs",
  "final_direction_approvals",
  "production_asset_validations",
  "assets",
  "print_projects",
  "artwork_versions",
  "generation_jobs",
];
console.log(
  JSON.stringify(
    {
      urlHost: new URL(url).host,
      openapiStatus: res.status,
      tables: Object.fromEntries(
        tables.map((t) => [t, text.includes(`"${t}"`) ? "present" : "missing"]),
      ),
    },
    null,
    2,
  ),
);

for (const path of [
  "final_artwork_jobs?select=id,provider_key,provider_request_id,provider_status&limit=1",
  "assets?select=id,final_artwork_job_id,production_role&limit=1",
  "production_asset_validations?select=id&limit=1",
  "final_direction_approvals?select=id&limit=1",
]) {
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const body = await r.text();
  console.log(
    JSON.stringify({
      path: path.split("?")[0],
      status: r.status,
      ok: r.ok,
      body: body.slice(0, 200),
    }),
  );
}
