// Keeps what the doctor couldn't explain, so recurring failures can become rules.
// Everything is stored locally (~/.hyperexecute-studio/feedback), masked, and never sent anywhere.
//   unmatched/<id>.json   a run or pasted log the rules didn't recognize (status unknown / needs-attention,
//                         or failed tests classified "unknown")
//   outcomes.jsonl        one line per fix applied or custom YAML used, and per finished attempt, so the review
//                         can tell which rules' fixes worked and which were overridden
// HE_FEEDBACK=off turns it off; HE_FEEDBACK_DIR moves it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { loadCreds } from "./credentials.js";
import { ERR_LINE, cleanLine, isNoise, headline } from "./loglines.js";

export { cleanLine, isNoise, headline };

export const feedbackDir = () => process.env.HE_FEEDBACK_DIR || path.join(os.homedir(), ".hyperexecute-studio", "feedback");
const enabled = () => !/^(off|0|false|no)$/i.test(process.env.HE_FEEDBACK || "");

// ---------- masking ----------

export function mask(text, secrets = []) {
  if (!text) return "";
  let s = String(text);
  for (const v of secrets) if (v && v.length >= 4) s = s.split(v).join("<secret>");
  // Values we know are secret: the saved account's key (and username, which identifies the customer)
  try {
    const c = loadCreds();
    for (const v of [c?.accessKey, c?.username]) if (v && v.length >= 4) s = s.split(v).join(v === c.accessKey ? "<access-key>" : "<lt-user>");
  } catch {}
  return s
    .replace(/(\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1<user>:<key>@") // user:key@host
    .replace(/\bLT_[A-Za-z0-9]{20,}\b/g, "<access-key>")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 <token>")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "<jwt>")
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "<aws-key>")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})\b/g, "<token>")
    .replace(/((?:access[_-]?key|accesskey|api[_-]?key|token|secret|password|passwd|pwd|LT_ACCESS_KEY|LT_USERNAME|username)["']?\s*[:=]\s*["']?)[^\s"',;&]{3,}/gi, "$1<masked>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "<hex>");
}

// Masks secrets but keeps ${{ .secrets.X }} references readable (they hold no secret).
export function maskKeepRefs(text) {
  const refs = [];
  // "&" can't start a masked value, so the placeholder survives mask()
  const held = String(text ?? "").replace(/\$\{\{[^}]*\}\}/g, (m) => `&HEREF${refs.push(m) - 1}&`);
  return mask(held).replace(/&HEREF(\d+)&/g, (_, i) => refs[+i]);
}

// ---------- signature: groups the same failure across runs and repos ----------

export function signature(line) {
  const norm = String(line)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/(["'`]).*?\1/g, "<s>")
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@-]+){2,}/g, "<path>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\d+(\.\d+)*/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return crypto.createHash("sha1").update(norm).digest("hex").slice(0, 12);
}

// ---------- recording ----------

function write(rel, data) {
  const file = path.join(feedbackDir(), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { mode: 0o600 });
  return file;
}

// Called when a diagnosis leaves something unexplained. Returns the saved file (or null).
export function recordUnmatched({ source, diagnosis, logText, profile, yamlText, runId, secrets = [] }) {
  if (!enabled() || !diagnosis) return null;
  const unknownTests = (diagnosis.tests?.list || []).filter((t) => t.cause === "unknown");
  const unexplained = ["unknown", "needs-attention"].includes(diagnosis.status) || unknownTests.length;
  if (!unexplained) return null;
  const m = (t) => mask(t, secrets);
  try {
    const head = m(unknownTests[0]?.evidence || headline(logText));
    const sig = signature(head);
    const at = new Date().toISOString();
    const rec = {
      at,
      source, // "run" | "pasted-logs"
      runId: runId || undefined,
      status: diagnosis.status,
      signature: sig,
      headline: head,
      matchedRules: (diagnosis.diagnoses || []).map((d) => d.id),
      framework: profile?.primaryFramework || null,
      language: profile?.language || null,
      yamlVersion: String(yamlText || "").match(/^version:\s*["']?([\d.]+)/m)?.[1] || null,
      unknownTests: unknownTests.slice(0, 20).map((t) => ({ label: m(t.label), evidence: m(t.evidence) })),
      digest: m(logDigestLite(logText)),
    };
    return write(path.join("unmatched", `${at.slice(0, 10)}-${sig}-${crypto.randomBytes(3).toString("hex")}.json`), JSON.stringify(rec, null, 2));
  } catch {
    return null; // feedback must never break a run
  }
}

function logDigestLite(text, max = 6000) {
  const lines = String(text || "").split("\n").map(cleanLine).filter(Boolean);
  const errs = lines.filter((l) => ERR_LINE.test(l) && !isNoise(l)).slice(-60);
  return [...new Set([...errs, "----- tail -----", ...lines.slice(-40)])].join("\n").slice(-max);
}

// event: "auto-fix" (fixes from the diagnosis applied) | "custom-yaml" (user/AI replaced the proposed fix) | "result" (an attempt finished)
export function recordOutcome(entry) {
  if (!enabled()) return;
  try {
    const file = path.join(feedbackDir(), "outcomes.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch {}
}

// ---------- review ----------

export function reviewFeedback({ sinceDays = 30, includeReviewed = false } = {}) {
  const dir = feedbackDir();
  const since = Date.now() - sinceDays * 864e5;
  const read = (sub) => {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => {
      try { return { file: path.join(d, f), ...JSON.parse(fs.readFileSync(path.join(d, f), "utf8")) }; } catch { return null; }
    }).filter((r) => r && Date.parse(r.at) >= since);
  };
  const items = [...read("unmatched"), ...(includeReviewed ? read("reviewed") : [])];
  const groups = new Map();
  for (const r of items) {
    const g = groups.get(r.signature) || { signature: r.signature, count: 0, headline: r.headline, frameworks: new Set(), statuses: new Set(), first: r.at, last: r.at, files: [] };
    g.count++;
    if (r.framework) g.frameworks.add(r.framework);
    g.statuses.add(r.status);
    if (r.at < g.first) g.first = r.at;
    if (r.at > g.last) { g.last = r.at; g.headline = r.headline; }
    g.files.push(r.file);
    groups.set(r.signature, g);
  }
  const unmatched = [...groups.values()]
    .sort((a, b) => b.count - a.count || (b.last > a.last ? 1 : -1))
    .map((g) => ({ ...g, frameworks: [...g.frameworks], statuses: [...g.statuses], files: g.files.slice(0, 3), recurring: g.count > 1 }));

  // Fix outcomes: for each rule, how often its fix was applied, overridden, and what the next attempt did.
  const outcomes = [];
  const of = path.join(dir, "outcomes.jsonl");
  if (fs.existsSync(of)) for (const l of fs.readFileSync(of, "utf8").split("\n")) { try { const o = JSON.parse(l); if (Date.parse(o.at) >= since) outcomes.push(o); } catch {} }
  const results = new Map(outcomes.filter((o) => o.event === "result").map((o) => [o.runId, o]));
  const rules = {};
  const bump = (id, k) => { (rules[id] ||= { applied: 0, overridden: 0, nextPassed: 0, nextSameFailure: 0, nextOther: 0, pending: 0 })[k]++; };
  for (const o of outcomes.filter((x) => x.event === "auto-fix" || x.event === "custom-yaml")) {
    for (const id of o.ruleIds || []) {
      bump(id, o.event === "auto-fix" ? "applied" : "overridden");
      if (o.event !== "auto-fix") continue;
      const next = results.get(o.nextRunId);
      if (!next) bump(id, "pending");
      else if (["passed", "passed-with-failures", "test-failures"].includes(next.status)) bump(id, "nextPassed");
      else if ((next.ruleIds || []).includes(id)) bump(id, "nextSameFailure");
      else bump(id, "nextOther");
    }
  }
  const suspectRules = Object.entries(rules).filter(([, r]) => r.overridden > 0 || r.nextSameFailure > 0).map(([id, r]) => ({ id, ...r }));

  // A YAML change the agent wrote (no rule proposed it) made the next run pass: draft the rule that would have.
  const drafts = new Map();
  for (const o of outcomes.filter((x) => x.event === "custom-fix-worked")) {
    const sig = o.headline ? signature(o.headline) : [...(o.ruleIds || [])].sort().join(",") || "no-headline";
    const g = drafts.get(sig) || { signature: sig, headline: o.headline, times: 0, frameworks: new Set(), change: o.change, last: o.at };
    g.times++;
    if (o.framework) g.frameworks.add(o.framework);
    if (o.at >= g.last) { g.last = o.at; g.change = o.change; }
    drafts.set(sig, g);
  }
  const ruleDrafts = [...drafts.values()]
    .sort((a, b) => b.times - a.times || (b.last > a.last ? 1 : -1))
    .map((g) => ({ ...g, frameworks: [...g.frameworks] }))
    .map((g) => ({ ...g, draft: draftRule(g) }));
  return {
    dir,
    sinceDays,
    unmatchedTotal: items.length,
    unmatched,
    rules,
    suspectRules,
    ruleDrafts,
    next: (ruleDrafts.length ? `${ruleDrafts.length} fix(es) the agent wrote made the next run pass: review each ruleDrafts entry, finish it as a RULES entry in src/doctor.js (or a generator change, when every repo of that framework needs it) with a smoke test. ` : "") + (unmatched.length
      ? "For each recurring group: read one file, write a RULES / TEST_RULES entry in src/doctor.js with a regex for the headline, add a smoke test using the masked digest, then call review_diagnosis_feedback with markReviewed: [signature]."
      : "Nothing unmatched in this period."),
  };
}

// A starting point for a doctor.js rule from a failure and the change that fixed it. Never applied by itself:
// a person checks the regex isn't too broad and turns the comment into a patch.
function draftRule({ headline, change, frameworks }) {
  const phrase = String(headline || "")
    .replace(/[.*+?^${}()|[\]\\/]/g, (c) => "\\" + c)
    .replace(/\d+/g, "\\d+")
    .slice(0, 100);
  const slug = String(headline || "agent-fix").toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 4).join("-") || "agent-fix";
  const lines = [...(change?.removed || []).map((l) => `    //   - ${l.trim()}`), ...(change?.added || []).map((l) => `    //   + ${l.trim()}`)].join("\n");
  return [
    "{",
    `  id: "${slug}", category: "setup", // seen with: ${(frameworks || []).join(", ") || "?"}`,
    `  re: /${phrase}/i,`,
    `  title: "${String(headline || "").slice(0, 70).replace(/"/g, "'")}",`,
    `  why: "TODO: why this fails on HyperExecute",`,
    "  fix: (ctx) => ({",
    "    summary: \"TODO\",",
    "    patch: (d) => {",
    "    // the change that made the next run pass:",
    lines,
    "    },",
    "  }),",
    "},",
  ].join("\n");
}

// Moves a group's files to reviewed/ so it drops out of the next review.
export function markReviewed(signatures) {
  const dir = feedbackDir();
  const src = path.join(dir, "unmatched");
  const dst = path.join(dir, "reviewed");
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  let n = 0;
  for (const f of fs.readdirSync(src)) if (signatures.some((s) => f.includes(`-${s}-`))) { fs.renameSync(path.join(src, f), path.join(dst, f)); n++; }
  return n;
}
