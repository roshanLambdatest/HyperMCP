// One place for the user's LambdaTest credentials, shared by the MCP server and the VS Code Studio:
// ~/.hyperexecute-studio/credentials.json (mode 600). Environment variables win when set.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CREDS_FILE = path.join(os.homedir(), ".hyperexecute-studio", "credentials.json");

export function loadCreds() {
  if (process.env.LT_USERNAME && process.env.LT_ACCESS_KEY) return { username: process.env.LT_USERNAME, accessKey: process.env.LT_ACCESS_KEY, source: "environment" };
  try {
    const j = JSON.parse(fs.readFileSync(CREDS_FILE, "utf8"));
    if (j.username && j.accessKey) return { username: j.username, accessKey: j.accessKey, source: CREDS_FILE, verifiedAt: j.verifiedAt };
  } catch {}
  return null;
}

export function saveCreds({ username, accessKey }) {
  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true, mode: 0o700 });
  const tmp = CREDS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ username, accessKey, verifiedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CREDS_FILE);
  try { fs.chmodSync(CREDS_FILE, 0o600); } catch {}
}

export function clearCreds() {
  try { fs.rmSync(CREDS_FILE); } catch {}
}

export async function verifyCreds(username, accessKey) {
  try {
    const res = await fetch("https://api.lambdatest.com/automation/api/v1/builds?limit=1", {
      headers: { Authorization: "Basic " + Buffer.from(`${username}:${accessKey}`).toString("base64") },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 200) return { ok: true, text: `Connected as ${username}` };
    if (res.status === 401) return { ok: false, text: "Invalid username or access key (401)" };
    return { ok: false, text: `LambdaTest API returned ${res.status}` };
  } catch (e) {
    return { ok: false, text: `Could not reach LambdaTest: ${e.message}` };
  }
}

// The saved YAML keeps ${{ .secrets.LT_USERNAME }} references (safe to commit). For a run, write a
// short-lived copy with the user's values filled in, so the VMs get them without portal secrets.
// Returns {config, cleanup}; cleanup() deletes the copy.
// Filled-in copies still on disk; removed if the process exits mid-run.
const pending = new Set();
process.once("exit", () => { for (const f of pending) try { fs.rmSync(f); } catch {} });

export function runtimeConfig(repoPath, config, creds) {
  const src = path.resolve(repoPath, config);
  const text = fs.readFileSync(src, "utf8");
  const values = { LT_USERNAME: creds.username, LT_ACCESS_KEY: creds.accessKey };
  // quote the value unless the reference already sits inside quotes (usernames may contain @ or :)
  const filled = text.replace(/(["']?)\$\{\{\s*\.secrets\.(LT_USERNAME|LT_ACCESS_KEY)\s*\}\}(["']?)/g, (_, q1, k, q2) => (q1 && q1 === q2 ? q1 + values[k] + q2 : JSON.stringify(values[k])));
  if (filled === text) return { config, cleanup: () => {}, injected: false };
  const name = `.hyperexecute-run-${process.pid}-${Date.now().toString(36)}.yaml`;
  const out = path.join(path.dirname(src), name);
  fs.writeFileSync(out, filled, { mode: 0o600 });
  pending.add(out);
  const cleanup = () => { if (pending.delete(out)) try { fs.rmSync(out); } catch {} };
  return { config: path.relative(path.resolve(repoPath), out) || name, cleanup, injected: true };
}
