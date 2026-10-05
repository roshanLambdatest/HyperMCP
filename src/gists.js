// GitHub gists as knowledge: real HyperExecute setups (YAMLs, discovery scripts, runTest.sh…) from the field.
// They are fetched into the local knowledge cache (~/.hyperexecute-studio/kb-cache/gists), masked, and searched
// with everything else. Nothing is bundled into the package or the web version.
//
// Env:
//   HE_GISTS      comma-separated GitHub users or gist links (default: the team's shared gists, RishabhLambdaTest);
//                 "off" turns gist knowledge off
//   GITHUB_TOKEN  optional; raises GitHub's rate limit and lets a token's owner include their secret gists

import fs from "node:fs";
import path from "node:path";
import { KB_CACHE_DIR } from "./knowledge.js";
import { maskKeepRefs } from "./feedback.js";

const API = process.env.HE_GITHUB_API || "https://api.github.com"; // overridable for tests
const MAX_FILE = 300 * 1024;
// never keep files that look like they hold credentials
const SECRET_FILE = /cred|secret|passw|token|\.env$|\.pem$|\.key$|\.p12$|id_rsa|\.keystore$/i;
const TEXT_FILE = /\.(ya?ml|json|js|cjs|mjs|ts|sh|bash|ps1|bat|cmd|py|java|kt|gradle|groovy|xml|properties|md|txt|feature|robot|rb|cs|conf|cfg|ini|toml|patch|diff)$|^[^.]+$/i;

export const gistsDir = () => path.join(KB_CACHE_DIR, "gists");
const indexFile = () => path.join(gistsDir(), "index.json");

// The shared pool every install syncs unless HE_GISTS says otherwise.
export const DEFAULT_GIST_SOURCES = "RishabhLambdaTest";
export const gistSources = () => {
  const v = process.env.HE_GISTS;
  if (v === undefined || v.trim() === "") return DEFAULT_GIST_SOURCES;
  return /^(off|none|false|0|no)$/i.test(v.trim()) ? "" : v.trim();
};

// "RishabhLambdaTest", "https://gist.github.com/RishabhLambdaTest", "https://gist.github.com/<user>/<id>" or "<id>"
export function parseGistSources(value = gistSources()) {
  const users = [], ids = [];
  for (const raw of String(value).split(/[\s,]+/).filter(Boolean)) {
    const m = raw.match(/gist\.github\.com\/([\w-]+)(?:\/([0-9a-f]{20,}))?/i);
    if (m?.[2]) ids.push(m[2]);
    else if (m?.[1]) users.push(m[1]);
    else if (/^[0-9a-f]{20,}$/i.test(raw)) ids.push(raw);
    else if (/^[\w-]+$/.test(raw)) users.push(raw);
  }
  return { users: [...new Set(users)], ids: [...new Set(ids)] };
}

async function get(url, token, asText) {
  const res = await fetch(url, { headers: { Accept: asText ? "text/plain" : "application/vnd.github+json", "User-Agent": "hyperexecute-studio", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 429 ? " (GitHub rate limit: set GITHUB_TOKEN or try again in an hour)" : res.status === 404 ? " (no such user or gist, or it's secret)" : "";
    throw new Error(`GitHub ${res.status}${hint}: ${url.replace(/\?.*/, "")}`);
  }
  return asText ? res.text() : res.json();
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

// Masks secrets, including CLI-style "--key abc" that the generic masking misses.
export function maskGistText(text) {
  return maskKeepRefs(text).replace(/((?:^|\s)--?(?:key|access[-_]?key|accessKey|user|username|token|password)\s+)(?![$%<])[^\s"']+/gi, "$1<masked>");
}

function readIndex() {
  try { return JSON.parse(fs.readFileSync(indexFile(), "utf8")); } catch { return { gists: {} }; }
}

// Fetch the gists (only the ones that changed since the last sync) into the knowledge cache.
export async function syncGists({ sources = gistSources(), token = process.env.GITHUB_TOKEN, force = false, maxAgeHours = 6 } = {}) {
  const { users, ids } = parseGistSources(sources);
  if (!users.length && !ids.length) throw new Error("Gist knowledge is off (HE_GISTS=off). Set HE_GISTS to a GitHub user or gist links.");
  const index = readIndex();
  if (!force && index.syncedAt && index.sources === String(sources) && Date.now() - Date.parse(index.syncedAt) < maxAgeHours * 36e5) {
    return { skipped: `synced ${index.syncedAt}; pass force to refresh`, ...gistsStatus() };
  }
  // list every gist (user listings are paged, 100 at a time)
  const listed = [];
  for (const u of users) {
    for (let page = 1; page <= 10; page++) {
      const batch = await get(`${API}/users/${encodeURIComponent(u)}/gists?per_page=100&page=${page}`, token);
      listed.push(...batch);
      if (batch.length < 100) break;
    }
  }
  for (const id of ids) listed.push(await get(`${API}/gists/${id}`, token));

  const seen = new Set();
  const out = { sources: users.concat(ids), gists: 0, files: 0, updated: 0, skipped: [], removed: 0 };
  const work = [];
  for (const g of listed) {
    seen.add(g.id);
    out.gists++;
    const prev = index.gists[g.id];
    if (!force && prev?.updated_at === g.updated_at && prev.files.every((f) => fs.existsSync(path.join(gistsDir(), f)))) { out.files += prev.files.length; continue; }
    work.push(g);
  }
  // fetch changed gists, a few at a time
  const fetchGist = async (g) => {
    const owner = g.owner?.login || "unknown";
    const files = [];
    if (index.gists[g.id]) for (const f of index.gists[g.id].files) fs.rmSync(path.join(gistsDir(), f), { force: true });
    for (const f of Object.values(g.files || {})) {
      if (SECRET_FILE.test(f.filename)) { out.skipped.push(`${f.filename} (looks like credentials)`); continue; }
      if (!TEXT_FILE.test(f.filename) || f.size > MAX_FILE) { out.skipped.push(`${f.filename} (${f.size > MAX_FILE ? "too large" : "not text"})`); continue; }
      const raw = typeof f.content === "string" && !f.truncated ? f.content : await get(f.raw_url, token, true);
      const about = (g.description || "").trim();
      const header = [`# Gist: ${about || f.filename}${about ? ` (${f.filename})` : ""}`, `# From ${owner}'s gists, updated ${String(g.updated_at).slice(0, 10)}: https://gist.github.com/${owner}/${g.id}`, `# A field example of a HyperExecute setup; check it against the current docs before reusing it.`, ""].join("\n");
      const rel = path.posix.join(slug(owner), `${g.id.slice(0, 8)}-${slug(f.filename)}.txt`);
      fs.mkdirSync(path.join(gistsDir(), slug(owner)), { recursive: true });
      fs.writeFileSync(path.join(gistsDir(), rel), header + maskGistText(raw).replace(/\r\n/g, "\n"));
      files.push(rel);
    }
    index.gists[g.id] = { updated_at: g.updated_at, owner, description: g.description || "", files };
    out.files += files.length;
    out.updated++;
  };
  for (let i = 0; i < work.length; i += 6) await Promise.all(work.slice(i, i + 6).map(fetchGist));
  // gists that were deleted (or made secret) leave the knowledge base too
  for (const [id, g] of Object.entries(index.gists)) {
    if (seen.has(id)) continue;
    for (const f of g.files) fs.rmSync(path.join(gistsDir(), f), { force: true });
    delete index.gists[id];
    out.removed++;
  }
  Object.assign(index, { syncedAt: new Date().toISOString(), sources: String(sources) });
  fs.mkdirSync(gistsDir(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(index, null, 2));
  return out;
}

export function gistsStatus() {
  const index = readIndex();
  const gists = Object.values(index.gists || {});
  return { dir: gistsDir(), sources: index.sources || null, syncedAt: index.syncedAt || null, gists: gists.length, files: gists.reduce((n, g) => n + g.files.length, 0) };
}
