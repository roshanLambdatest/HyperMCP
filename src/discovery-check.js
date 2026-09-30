// Compares what we expected HyperExecute to discover/run with what it actually did.
// The costly mistake is a job that goes green having run 0 tests (or a fraction of them).
//   expected: the last local dry run of the same discovery command (saved per repo + YAML), or the analyzer's counts
//   actual:   the discovered count the CLI prints, and the test cases found in the downloaded reports

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";

const DIR = () => path.join(process.env.HE_STATE_DIR || path.join(os.homedir(), ".hyperexecute-studio"), "discovery");
const key = (repo, yamlPath) => crypto.createHash("sha1").update(`${path.resolve(repo)}|${yamlPath || "hyperexecute.yaml"}`).digest("hex").slice(0, 16);

export function saveDryRun(repo, yamlPath, { command, discovered, items }) {
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    fs.writeFileSync(path.join(DIR(), key(repo, yamlPath) + ".json"), JSON.stringify({ at: new Date().toISOString(), repo: path.resolve(repo), yamlPath, command, discovered, sample: items.slice(0, 20) }, null, 2));
  } catch {}
}

export function loadDryRun(repo, yamlPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR(), key(repo, yamlPath) + ".json"), "utf8"));
  } catch {
    return null;
  }
}

// Test cases the analyzer found statically (null when the stack doesn't let us count them).
function staticTestCount(profile) {
  const t = profile.tests;
  if (profile.primaryFramework === "cucumber" || ["behave", "cucumber-js", "pytest-bdd"].includes(profile.primaryFramework)) return t.scenarios.length || null;
  if (profile.language === "java") return t.classes.reduce((n, c) => n + (c.methods?.length || 0), 0) || null;
  if (profile.primaryFramework === "pytest") return t.functions.length || null;
  return null; // JS/.NET: one file/class can hold any number of tests
}

// Discovered counts as printed by the CLI / discovery stage (several phrasings seen across CLI versions).
export function platformDiscoveredCount(output) {
  const pats = [
    /(\d+)\s+tests?\s+(?:were\s+|have been\s+)?discovered/i,
    /discovered\s+(\d+)\s+tests?/i,
    /test\s*discovery[^\n]{0,40}?(?:found|:)\s*(\d+)/i,
    /total\s+(?:discovered\s+)?tests?\s*[:=]\s*(\d+)/i,
    /total\s+items\s+discovered\s*[:=]\s*(\d+)/i,
  ];
  let last = null;
  for (const re of pats) for (const m of String(output || "").matchAll(new RegExp(re.source, "gi"))) last = Number(m[1]);
  return last;
}

export function checkDiscovery({ repo, yamlPath, yamlText, profile, output, tests, targeted }) {
  let doc = {};
  try { doc = YAML.parse(yamlText || "") || {}; } catch {}
  const cmd = doc?.testDiscovery?.command || null;
  const dry = cmd ? loadDryRun(repo, yamlPath) : null;
  const dryMatches = dry && dry.command === cmd;
  const expectedItems = dryMatches ? dry.discovered : null;
  const expectedTests = targeted ? null : staticTestCount(profile);
  const platform = platformDiscoveredCount(output);
  const executed = tests?.length ?? 0;
  const out = {
    expectedItems,
    expectedItemsFrom: dryMatches ? `dry run ${dry.at}` : cmd ? "no dry run of this discovery command" : doc.matrix ? "matrix" : "v0.2 remote discovery",
    expectedTests,
    platformDiscovered: platform,
    executedTests: executed || null,
    verdict: "ok",
    message: null,
  };
  if (doc.matrix && !doc.autosplit) {
    out.verdict = "n/a";
    out.message = "Matrix mode: tasks are the matrix combinations.";
    return out;
  }
  if (platform === 0 || (!executed && /\b0 tests? (?:were )?discovered|discovered 0 tests?/i.test(output || ""))) {
    out.verdict = "zero-tests";
    out.message = `HyperExecute discovered 0 tests${expectedItems ? `, but the local dry run found ${expectedItems}` : ""}. The job ran nothing — check the discovery command/paths (and for v0.2, that there is no testDiscovery block).`;
  } else if (platform != null && expectedItems != null && platform !== expectedItems) {
    out.verdict = platform < expectedItems ? "fewer-than-expected" : "more-than-expected";
    out.message = `HyperExecute discovered ${platform} item(s); the local dry run found ${expectedItems}. Paths or tools may differ on the VM (OS, shell, checked-out files).`;
  } else if (executed && expectedTests && executed < expectedTests * 0.5) {
    out.verdict = "fewer-than-expected";
    out.message = `Reports show ${executed} test case(s) ran, but the repo has about ${expectedTests}. Some tests may not be discovered, or a filter/profile excludes them.`;
  } else if (!executed && platform == null) {
    out.verdict = "unconfirmed";
    out.message = "No discovered count in the CLI output and no per-test reports were downloaded, so the number of tests that ran can't be confirmed.";
  }
  return out;
}
