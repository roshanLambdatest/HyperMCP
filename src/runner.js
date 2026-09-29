// Runs the HyperExecute CLI as a child process, streams its output, and returns what the doctor needs.
// Credentials are passed through the environment (LT_USERNAME / LT_ACCESS_KEY), never as arguments.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CACHE_DIR = path.join(os.homedir(), ".hyperexecute-studio", "bin");

export function cliDownloadUrl() {
  const p = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  return `https://downloads.lambdatest.com/hyperexecute/${p}/hyperexecute${p === "windows" ? ".exe" : ""}`;
}

// Prefer a CLI the repo already ships; otherwise use (or download) a shared copy outside the repo.
export async function ensureCli(repoPath, { download = true } = {}) {
  if (process.env.HE_CLI_PATH && fs.existsSync(process.env.HE_CLI_PATH)) return process.env.HE_CLI_PATH;
  const exe = process.platform === "win32" ? "hyperexecute.exe" : "hyperexecute";
  const inRepo = path.join(repoPath, exe);
  if (fs.existsSync(inRepo)) return inRepo;
  const cached = path.join(CACHE_DIR, exe);
  if (fs.existsSync(cached)) return cached;
  if (!download) return null;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const res = await fetch(cliDownloadUrl());
  if (!res.ok) throw new Error(`HyperExecute CLI download failed (${res.status})`);
  const tmp = cached + ".part";
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  if (process.platform !== "win32") fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, cached);
  return cached;
}

// Starts a run. onData(chunk) streams output. Returns {promise, stop}; promise resolves to
// {exitCode, output, startedAt, finishedAt, stopped}.
export function startRun({ cli, repoPath, config = "hyperexecute.yaml", username, accessKey, onData = () => {}, extraArgs = [] }) {
  if (!username || !accessKey) throw new Error("LambdaTest username and access key are required (LT_USERNAME / LT_ACCESS_KEY).");
  const startedAt = Date.now();
  const args = ["--config", config, "--download-logs", "--download-report", ...extraArgs];
  const child = spawn(cli, args, {
    cwd: repoPath,
    env: { ...process.env, LT_USERNAME: username, LT_ACCESS_KEY: accessKey },
    windowsHide: true,
  });
  let output = "";
  let stopped = false;
  const secretRe = new RegExp(accessKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  const take = (buf) => {
    const s = buf.toString().replace(secretRe, "****"); // never echo the key
    output += s;
    if (output.length > 8 * 1024 * 1024) output = output.slice(-6 * 1024 * 1024);
    onData(s);
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const promise = new Promise((resolve) => {
    child.on("error", (e) => { take(Buffer.from(`\n[runner] failed to start CLI: ${e.message}\n`)); resolve({ exitCode: -1, output, startedAt, finishedAt: Date.now(), stopped }); });
    child.on("close", (code) => resolve({ exitCode: code ?? -1, output, startedAt, finishedAt: Date.now(), stopped }));
  });
  return {
    promise,
    pid: child.pid,
    stop: () => { stopped = true; try { child.kill("SIGINT"); setTimeout(() => child.kill("SIGKILL"), 5000); } catch {} },
  };
}

// Best-effort job details from the HyperExecute API (response shape isn't publicly documented,
// so the raw JSON is returned trimmed for display / AI context).
export async function fetchJobInfo(jobId, username, accessKey) {
  if (!jobId) return null;
  try {
    const res = await fetch(`https://api.hyperexecute.cloud/v2.0/job/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: "Basic " + Buffer.from(`${username}:${accessKey}`).toString("base64"), Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { error: `job API ${res.status}` };
    const text = await res.text();
    return { raw: text.slice(0, 20000) };
  } catch (e) {
    return { error: e.message };
  }
}
