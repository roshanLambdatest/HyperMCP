// HyperExecute's own analyzer (`hyperexecute analyze`), run on the repo before a YAML is generated.
// It reports the language, the runtime and build tool on this machine, what the project declares,
// test framework versions, private registries/endpoints and URLs the VMs can't reach.
// It covers Java, JavaScript/TypeScript and C# (with the dotnet SDK installed); for other languages
// it reports why it has nothing, and the YAML comes from the Studio's own analysis.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const LOG = "hyperexecute-analyze.log";
const PUBLIC_REGISTRIES = /registry\.npmjs\.org|registry\.yarnpkg\.com|repo1?\.maven(\.apache)?\.org|repo\.maven\.apache\.org|plugins\.gradle\.org|pypi\.org|api\.nuget\.org|rubygems\.org/i;

const strip = (s) => String(s ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const list = (v) => (!v || /^(n\/a|none|-)$/i.test(v.trim()) ? [] : v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean));
const unknown = (v) => (!v || /^unknown$/i.test(v.trim()) ? null : v.trim());

// The analyzer's table and messages → a plain object.
export function parseCliAnalyze(output) {
  const text = strip(output);
  const rows = {};
  let last = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/);
    if (!m || /^ITEM$/i.test(m[1])) continue;
    if (m[1]) rows[(last = m[1].toLowerCase())] = m[2];
    else if (last && m[2]) rows[last] += "\n" + m[2];
  }
  const get = (...names) => names.map((n) => rows[n]).find((v) => v !== undefined) ?? null;

  const runtimeRaw = get("runtime version") || "";
  const javaMachine = runtimeRaw.match(/version "(?:1\.)?(\d+)/);
  const nodeMachine = runtimeRaw.match(/^v(\d+)\./);
  const modules = [...runtimeRaw.matchAll(/Module:\s*(\S+)\s*->\s*\[([^\]]*)\]/g)].map((m) => ({ id: m[1], settings: m[2].trim() }));
  const declared = runtimeRaw.match(/maven\.compiler\.(?:release|source|target):\s*(\d+)/) || runtimeRaw.match(/(?:sourceCompatibility|languageVersion)\D{0,10}(\d+)/);

  const frameworks = list((get("test frameworks") || "").replace(/\s*->\s*/g, "->").replace(/\n/g, " ")).map((entry) => {
    const [name, coordinate = ""] = entry.split("->");
    return { name, coordinate, version: (coordinate.match(/[:@]v?(\d[\w.+-]*)$/) || [])[1] || null };
  });
  const registries = list(get("private repository", "private registry"));

  const unsupported = text.match(/does not support language (\w[\w#+]*)/i);
  const noLanguage = /No language detected/i.test(text);
  const missingTool = text.match(/exec: "([\w.-]+)": executable file not found/);
  const language = unknown(get("primary language"));
  let reason = null;
  if (unsupported) reason = `HyperExecute analyze doesn't support ${unsupported[1]} yet`;
  else if (noLanguage) reason = "HyperExecute analyze couldn't detect the project's language";
  else if (missingTool && !frameworks.length) reason = `${missingTool[1]} isn't installed on this machine, so HyperExecute analyze couldn't read the project`;
  else if (!language) reason = "HyperExecute analyze returned no result";

  return {
    supported: !reason,
    reason,
    language,
    machineRuntime: javaMachine ? javaMachine[1] : nodeMachine ? nodeMachine[1] : null,
    declaredRuntime: declared ? declared[1] : null,
    modules,
    buildTool: unknown(get("build tool")),
    buildToolVersion: (unknown(get("build tool version")) || "").match(/(?:Apache Maven|Gradle)\s+([\d.]+)/)?.[1] || null,
    packageManager: unknown(get("package manager")),
    packageManagerVersion: unknown(get("package manager version")),
    frameworks,
    privateRegistries: registries.filter((r) => !PUBLIC_REGISTRIES.test(r)),
    privateEndpoints: list(get("private endpoints")),
    inaccessibleUrls: list(get("inaccessible urls")),
  };
}

// Runs `hyperexecute analyze` in the repo with the user's account (in the environment, never as
// arguments, like the runs). Removes the log file it writes unless the repo already had one.
export function runCliAnalyze({ cli, repoPath, username, accessKey, timeoutMs = 120000 }) {
  if (!username || !accessKey) return Promise.reject(new Error("A LambdaTest username and access key are needed to run HyperExecute analyze."));
  const log = path.join(repoPath, LOG);
  const hadLog = fs.existsSync(log);
  return new Promise((resolve, reject) => {
    const child = spawn(path.resolve(cli), ["analyze", "--disable-updates", "--hide-file-tree"], {
      cwd: repoPath,
      env: { ...process.env, LT_USERNAME: username, LT_ACCESS_KEY: accessKey },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const done = () => { clearTimeout(timer); if (!hadLog) try { fs.rmSync(log); } catch {} };
    child.on("error", (e) => { done(); reject(new Error(`HyperExecute analyze couldn't start: ${e.message}`)); });
    child.on("close", (code, signal) => {
      done();
      if (signal) return reject(new Error(`HyperExecute analyze didn't finish within ${Math.round(timeoutMs / 1000)}s.`));
      const output = out.split(accessKey).join("****");
      resolve({ ...parseCliAnalyze(output), exitCode: code, output: output.slice(-20000), at: new Date().toISOString() });
    });
  });
}

// What the analysis changes before generating: the profile (runtime version), default options
// (tunnel when something is private) and notes that say where each choice came from.
export function applyCliAnalyze(profile, a) {
  if (!a) return { profile, defaults: {}, notes: [] };
  const notes = [];
  const defaults = {};
  const p = { ...profile, cliAnalyze: a };
  if (!a.supported) {
    notes.push(`${a.reason}; the YAML comes from the Studio's own analysis of the repo.`);
    return { profile: p, defaults, notes };
  }
  const isJava = /java/i.test(a.language || "") && /java/i.test(profile.language || "java");
  if (a.frameworks.length) notes.push(`HyperExecute analyze: ${a.frameworks.map((f) => `${f.coordinate || f.name}${f.version && !f.coordinate ? ` ${f.version}` : ""}`).join(", ")}.`);
  if (isJava && a.declaredRuntime) {
    if (!profile.runtimeVersion) {
      p.runtimeVersion = a.declaredRuntime;
      notes.push(`Java ${a.declaredRuntime} comes from the project's build settings, found by HyperExecute analyze.`);
    } else if (String(parseFloat(profile.runtimeVersion)) !== String(parseFloat(a.declaredRuntime))) {
      notes.push(`The build declares Java ${profile.runtimeVersion} in one place and ${a.declaredRuntime} in another (HyperExecute analyze); check which one the tests need.`);
    }
  }
  // a.machineRuntime is this machine's version, not the project's: it never changes the YAML, so the
  // same repo gives the same YAML on every machine
  const reach = [...a.privateEndpoints, ...a.inaccessibleUrls];
  if (reach.length || a.privateRegistries.length) {
    defaults.tunnel = true;
    notes.push(`Tunnel on: HyperExecute analyze found ${[reach.length ? `${reach.length} private or unreachable URL${reach.length > 1 ? "s" : ""} (${reach.slice(0, 3).join(", ")})` : "", a.privateRegistries.length ? `a private registry (${a.privateRegistries[0]})` : ""].filter(Boolean).join(" and ")} that the VMs can only reach through it.`);
  }
  return { profile: p, defaults, notes };
}
