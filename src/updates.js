// Tells the user when a newer HyperExecute Studio release exists. `npx -y github:…` keeps its first cached
// copy, so without this teammates silently stay on old versions.
// At most once a day (cached in ~/.hyperexecute-studio/update-check.json), in the background with a short
// timeout; a failed check is ignored. HE_UPDATE_CHECK=off turns it off.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const API = process.env.HE_GITHUB_API || "https://api.github.com"; // overridable for tests
const REPO = "roshanLambdatest/HyperMCP";
const DAY = 24 * 3600 * 1000;
const HOW = "npx clear-npx-cache, then restart Claude Code";
const cacheFile = () => path.join(process.env.HE_STATE_DIR || path.join(os.homedir(), ".hyperexecute-studio"), "update-check.json");

export const CURRENT = (() => {
  try { return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; } catch { return "0.0.0"; }
})();

const parts = (v) => String(v).replace(/^v/, "").split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
export function isNewer(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

let latest = null;
let noted = false;

async function check() {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    if (Date.now() - c.checkedAt < DAY && c.latest) return c.latest;
  } catch {}
  const res = await fetch(`${API}/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "hyperexecute-studio" }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const v = String((await res.json()).tag_name || "").replace(/^v/, "");
  if (!/^\d+\.\d+/.test(v)) return null;
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify({ checkedAt: Date.now(), latest: v }));
  } catch {}
  return v;
}

// Starts the check; never throws and never blocks startup. Returns the promise for tests.
export function startUpdateCheck() {
  if (/^(off|0|false|no)$/i.test(process.env.HE_UPDATE_CHECK || "")) return Promise.resolve(null);
  return check().then((v) => (latest = v), () => null);
}

// { current, latest, how } when a newer release exists.
export const updateInfo = () => (latest && isNewer(latest, CURRENT) ? { current: CURRENT, latest, how: HOW } : undefined);

// The one-line note, once per session.
export function takeUpdateNote() {
  const u = updateInfo();
  if (!u || noted) return null;
  noted = true;
  return `HyperExecute Studio ${u.latest} is available (you have ${u.current}): run \`npx clear-npx-cache\` and restart Claude Code.`;
}
