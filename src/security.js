// Finds hard-coded LambdaTest credentials and reporting integrations that would send results to the
// customer's systems, and rewrites credentials to environment-variable lookups so whoever runs the
// tests (via HyperExecute secrets or the Studio's account field) supplies their own.

import fs from "node:fs";
import path from "node:path";

const IGNORED = new Set(["node_modules", ".git", "target", "build", "dist", "out", "bin", "obj", ".gradle", ".idea", ".vscode", "venv", ".venv", "__pycache__", "allure-results", "allure-report", "test-output", "playwright-report", "test-results", "coverage"]);
const TEXT_EXT = /\.(java|kt|groovy|py|robot|[cm]?[jt]sx?|cs|rb|php|properties|ya?ml|json|env|conf|ini|cfg|toml|xml|feature|runsettings|config|txt)$|(^|\/)\.env[\w.-]*$/;
const CODE_LANG = { java: "java", kt: "java", groovy: "java", py: "python", js: "js", mjs: "js", cjs: "js", ts: "js", jsx: "js", tsx: "js", cs: "csharp" };

function walk(root, max = 15000) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!IGNORED.has(e.name)) stack.push(full); }
      else if (e.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (TEXT_EXT.test(rel) && !/package-lock|yarn\.lock|pnpm-lock/.test(rel)) out.push(rel);
      }
    }
  }
  return out;
}

const read = (root, rel) => { try { const p = path.join(root, rel); return fs.statSync(p).size > 512 * 1024 ? "" : fs.readFileSync(p, "utf8"); } catch { return ""; } };
export const mask = (v) => (!v ? "" : v.length <= 4 ? "****" : `${v.slice(0, 3)}${"*".repeat(Math.min(12, v.length - 3))}`);
const isPlaceholder = (v) => /^(\$\{?|%|<|\{|your|xxx|user(name)?$|access_?key$|LT_(USERNAME|ACCESS_KEY)$|process\.env|System\.getenv|os\.environ)/i.test(v) || /^[*.]+$/.test(v) || v.length < 3;

// ---------- credentials ----------

const HUB_CREDS = /((?:https?|wss?):\/\/)([^:\/@\s"'`${}]+):([^@\s"'`${}]+)@((?:hub|mobile-hub|cdp|stage-hub|beta-hub)[\w.-]*\.(?:lambdatest|testmuai)\.com[^\s"'`]*)/g;
const USER_KEYS = "(?:LT_USERNAME|LT_USER|LAMBDATEST_USERNAME|LAMBDA_?TEST_?USER(?:NAME)?|lt[._]?username|lambdatest[._]?username|userName|username|user_name|user)";
const KEY_KEYS = "(?:LT_ACCESS_KEY|LT_ACCESSKEY|LT_KEY|LAMBDATEST_ACCESS_KEY|LAMBDATEST_KEY|lt[._]?access[._]?key|lambdatest[._]?(?:access[._]?)?key|accessKey|access_key|accesskey|accessToken)";
// key = "value" | key: 'value' | key=value (properties/.env) | "key": "value" (json)
const assignRe = (keys) => new RegExp(`(["']?)(${keys})\\1(\\s*(?:=|:|=>)\\s*)(["'\`]?)([^"'\`\\s,;)}{]+)\\4`, "g");
// getenv("LT_USERNAME", "fallback") / process.env.LT_USERNAME || "fallback" / getOrDefault("LT_USERNAME","x")
const FALLBACK_RE = /(?:System\.getenv\(\)\.getOrDefault|(?:os\.)?getenv|(?:os\.)?environ\.get)\(\s*["'](LT_USERNAME|LT_ACCESS_KEY)["']\s*,\s*["']([^"']+)["']\s*\)|process\.env\.(LT_USERNAME|LT_ACCESS_KEY)\s*(?:\|\||\?\?)\s*["'`]([^"'`]+)["'`]/g;

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

export function scanCredentials(repoPath) {
  const root = path.resolve(repoPath);
  const findings = [];
  for (const rel of walk(root)) {
    const text = read(root, rel);
    if (!text) continue;
    const ext = rel.split(".").pop();
    const lang = CODE_LANG[ext] || "config";
    const mentionsLT = /lambdatest|testmuai|LT:Options|lt:options|LT_USERNAME|LT_ACCESS_KEY/i.test(text);
    const push = (f) => findings.push({ file: rel, lang, ...f });

    for (const m of text.matchAll(HUB_CREDS)) {
      if (isPlaceholder(m[2]) && isPlaceholder(m[3])) continue;
      push({ line: lineOf(text, m.index), kind: "hub-url", username: mask(m[2]), accessKey: mask(m[3]), match: m[0], index: m.index, autoFix: lang !== "config" });
    }
    for (const m of text.matchAll(FALLBACK_RE)) {
      const name = m[1] || m[3];
      const value = m[2] || m[4];
      if (isPlaceholder(value)) continue;
      push({ line: lineOf(text, m.index), kind: "env-fallback", variable: name, value: mask(value), match: m[0], index: m.index, autoFix: lang !== "config" });
    }
    if (!mentionsLT) continue; // username/accessKey-style names only count in LambdaTest-related files
    // ltOptions.put("username", "x") / caps.setCapability("accessKey", "x") / lt_options["user"] = "x"
    for (const m of text.matchAll(/(?:\.(?:put|setCapability|set_capability|Add|AddAdditionalOption|AddAdditionalCapability)\(\s*|\[\s*)["'](username|user|userName|accessKey|access_key|accesskey)["']\s*(?:,|\]\s*=)\s*(["'])([^"']+)\2/g)) {
      const kind = /^user/i.test(m[1]) ? "username" : "access-key";
      if (isPlaceholder(m[3])) continue;
      push({ line: lineOf(text, m.index), kind, key: m[1], value: mask(m[3]), match: m[0], index: m.index, quote: m[2], autoFix: lang !== "config" });
    }
    if (/hostname\s*:\s*["'][^"']*(lambdatest|testmuai)/.test(text)) {
      for (const m of text.matchAll(/\b(user|key)(\s*:\s*)(["'])([^"']+)\3/g)) {
        if (isPlaceholder(m[4]) || findings.some((f) => f.file === rel && f.index === m.index)) continue;
        push({ line: lineOf(text, m.index), kind: m[1] === "user" ? "username" : "access-key", key: m[1], value: mask(m[4]), match: m[0], index: m.index, quote: m[3], autoFix: lang !== "config", confidence: "high" });
      }
    }
    // Explicit LambdaTest names (LT_USERNAME, lambdatest.accessKey…) are always credentials. Generic names
    // (username, user, accessKey…) are often the app-under-test's login, so they only count when that
    // variable is used in the LambdaTest connection (hub URL / LT:Options / capabilities).
    const ltLines = text.split("\n").filter((l) => /lambdatest|testmuai|hub\.|LT:Options|lt:options|ltOptions|lt_options|capabilit/i.test(l)).join("\n");
    const explicit = /LT_|lambda|^lt[._]/i;
    for (const [kind, keys] of [["username", USER_KEYS], ["access-key", KEY_KEYS]]) {
      for (const m of text.matchAll(assignRe(keys))) {
        const value = m[5];
        if (isPlaceholder(value) || /^(true|false|null|none|undefined|\d+)$/i.test(value)) continue;
        if (kind === "access-key" && value.length < 12) continue; // access keys are long
        if (kind === "username" && (value.length > 64 || /[()]/.test(value))) continue;
        if (findings.some((f) => f.file === rel && f.index <= m.index && m.index < f.index + f.match.length)) continue;
        const isExplicit = explicit.test(m[2]);
        const wired = new RegExp(`\\b${m[2].replace(/[.]/g, "\\.")}\\b`).test(ltLines);
        const configFile = lang === "config";
        if (!isExplicit && !wired && !configFile) continue;
        if (!isExplicit && configFile && !/lambdatest|LT_|hub\.lambdatest/i.test(text)) continue;
        push({ line: lineOf(text, m.index), kind, key: m[2], value: mask(value), match: m[0], index: m.index, quote: m[4], autoFix: !configFile && !!m[4], confidence: isExplicit ? "high" : "medium" });
      }
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return findings.map(({ index, match, quote, ...f }, i) => ({ id: i, ...f, _index: index, _match: match, _quote: quote }));
}

// Environment lookup expression per language
const ENV = {
  java: (v) => `System.getenv("${v}")`,
  python: (v) => `os.environ.get("${v}")`,
  js: (v) => `process.env.${v}`,
  csharp: (v) => `Environment.GetEnvironmentVariable("${v}")`,
};

function replacementFor(f) {
  const env = ENV[f.lang];
  if (!env) return null;
  const U = "LT_USERNAME", K = "LT_ACCESS_KEY";
  if (f.kind === "hub-url") {
    const m = new RegExp(HUB_CREDS.source).exec(f._match);
    const host = m[4];
    if (f.lang === "js") return `${m[1]}\${process.env.${U}}:\${process.env.${K}}@${host}`; // caller converts quotes to backticks
    if (f.lang === "python") return { expr: `f"${m[1]}{os.environ.get('${U}')}:{os.environ.get('${K}')}@${host}"` };
    if (f.lang === "csharp") return { expr: `$"${m[1]}{Environment.GetEnvironmentVariable("${U}")}:{Environment.GetEnvironmentVariable("${K}")}@${host}"` };
    return { expr: `"${m[1]}" + ${env(U)} + ":" + ${env(K)} + "@${host}"` };
  }
  if (f.kind === "env-fallback") return { whole: env(f.variable) };
  if (f.kind === "username" || f.kind === "access-key") return { value: env(f.kind === "username" ? U : K) };
  return null;
}

// Returns [{file, before, after, edits:[{start,end,text}]}] — pure, so callers can preview/diff before writing.
export function planCredentialFixes(repoPath, findings) {
  const root = path.resolve(repoPath);
  const byFile = new Map();
  for (const f of findings.filter((x) => x.autoFix)) (byFile.get(f.file) || byFile.set(f.file, []).get(f.file)).push(f);
  const plans = [];
  for (const [file, list] of byFile) {
    const before = read(root, file);
    let after = before;
    const edits = [];
    for (const f of [...list].sort((a, b) => b._index - a._index)) {
      const r = replacementFor(f);
      if (!r || after.slice(f._index, f._index + f._match.length) !== f._match) continue;
      let start = f._index, end = f._index + f._match.length, text;
      if (f.kind === "hub-url") {
        // widen to the surrounding string literal
        const q = after[start - 1];
        if (!["\"", "'", "`"].includes(q) || after[end] !== q) continue;
        start -= 1; end += 1;
        if (/[fFrRbBuU]/.test(after[start - 1] || "") && !/\w/.test(after[start - 2] || "")) start -= 1; // python f"" / r""
        text = typeof r === "string" ? "`" + r + "`" : r.expr;
      } else if (r.whole) {
        text = r.whole;
      } else {
        const m = f._match;
        const valueStart = m.lastIndexOf(f._quote, m.length - 2); // opening quote of the value
        start = f._index + valueStart;
        text = r.value;
      }
      after = after.slice(0, start) + text + after.slice(end);
      edits.push({ start, end, text, line: f.line, kind: f.kind });
    }
    if (!edits.length) continue;
    // python needs `import os`
    if (list[0].lang === "python" && /os\.environ/.test(after) && !/^\s*import os\b|^\s*from os import/m.test(after)) after = `import os\n${after}`;
    plans.push({ file, before, after, edits: edits.reverse() });
  }
  return plans;
}

export function applyCredentialFixes(repoPath, plans) {
  const root = path.resolve(repoPath);
  for (const p of plans) fs.writeFileSync(path.join(root, p.file), p.after);
  return plans.map((p) => ({ file: p.file, edits: p.edits.length }));
}

// ---------- reporting integrations ----------

const REPORTERS = [
  { id: "lambdatest-account", name: "LambdaTest account in code", re: /hub\.lambdatest\.com|cdp\.lambdatest\.com/, onlyWithCreds: true, why: "Results go to whichever LambdaTest account's credentials the code uses.", fix: "Replace hard-coded credentials with LT_USERNAME / LT_ACCESS_KEY (Fix button) so runs land in your account." },
  { id: "testrail", name: "TestRail", re: /testrail|index\.php\?\/api\/v2/i, why: "Test results are posted to the customer's TestRail.", fix: "Disable the TestRail listener/reporter for HyperExecute runs (e.g. remove the listener or gate it on an env var)." },
  { id: "jira-xray", name: "Jira / Xray / Zephyr", re: /xray|zephyr|atlassian\.net\/rest|jira\.[\w.-]+\/rest/i, why: "Results or defects are created in the customer's Jira.", fix: "Turn off the Jira/Xray upload for trial runs." },
  { id: "reportportal", name: "ReportPortal", re: /reportportal|rp\.endpoint|RP_ENDPOINT/i, why: "Launches are pushed to the customer's ReportPortal.", fix: "Add -Drp.enable=false (Java) or RP_ENABLED=false to the runner/env." },
  { id: "slack", name: "Slack webhook", re: /hooks\.slack\.com|slack[_-]?webhook/i, why: "Run notifications are posted to the customer's Slack.", fix: "Unset the webhook for HyperExecute runs." },
  { id: "teams", name: "Microsoft Teams webhook", re: /webhook\.office\.com|outlook\.office\.com\/webhook/i, why: "Run notifications are posted to the customer's Teams channel.", fix: "Unset the webhook for HyperExecute runs." },
  { id: "email", name: "Email reports", re: /javax\.mail|jakarta\.mail|smtplib|nodemailer|sendgrid|EmailableReporter2?\b.*send|SmtpClient/i, why: "Reports may be emailed to the customer's team.", fix: "Disable the email step/listener for trial runs." },
  { id: "allure-testops", name: "Allure TestOps", re: /ALLURE_ENDPOINT|allure\.endpoint|allurectl|testops/i, why: "Results are uploaded to the customer's Allure TestOps.", fix: "Don't pass ALLURE_ENDPOINT/ALLURE_TOKEN in HyperExecute env." },
  { id: "cypress-cloud", name: "Cypress Cloud / Currents", re: /--record\b|CYPRESS_RECORD_KEY|currents\.dev|projectId\s*:/i, why: "Runs are recorded to the customer's Cypress Cloud / Currents dashboard.", fix: "Remove --record and the record key from HyperExecute runs." },
  { id: "visual", name: "Percy / Applitools", re: /PERCY_TOKEN|@percy\/|applitools|APPLITOOLS_API_KEY/i, why: "Visual snapshots go to the customer's Percy/Applitools account (and consume their quota).", fix: "Unset the visual token for trial runs, or use LambdaTest SmartUI." },
  { id: "other-cloud", name: "Other cloud grid", re: /browserstack\.com|saucelabs\.com|ondemand\.[\w-]+\.saucelabs|hub-cloud\.browserstack/i, why: "Tests connect to another vendor's grid under the customer's account.", fix: "Point the driver at hub.lambdatest.com (Grid tab) for HyperExecute runs." },
  { id: "azure-devops", name: "Azure DevOps Test Plans", re: /dev\.azure\.com\/[\w-]+\/[\w-]+\/_apis\/test/i, why: "Results are published to the customer's Azure DevOps.", fix: "Disable the publish step for trial runs." },
  { id: "qtest", name: "qTest / PractiTest / TestLink", re: /qtestnet|practitest|testlink/i, why: "Results are synced to the customer's test-management tool.", fix: "Disable the sync for trial runs." },
];

export function scanReporting(repoPath, credentialFindings) {
  const root = path.resolve(repoPath);
  const hits = [];
  const credFiles = new Set((credentialFindings || scanCredentials(root)).map((f) => f.file));
  for (const rel of walk(root)) {
    const text = read(root, rel);
    if (!text) continue;
    const lines = text.split("\n");
    for (const r of REPORTERS) {
      if (r.onlyWithCreds && !credFiles.has(rel)) continue;
      const idx = lines.findIndex((l) => r.re.test(l));
      if (idx < 0) continue;
      hits.push({ integration: r.id, name: r.name, file: rel, line: idx + 1, snippet: lines[idx].trim().replace(new RegExp(HUB_CREDS.source, "g"), (_, a, u, k, h) => `${a}${mask(u)}:${mask(k)}@${h}`).slice(0, 160), why: r.why, fix: r.fix });
    }
  }
  return hits;
}

export function scanRepo(repoPath) {
  const credentials = scanCredentials(repoPath);
  const reporting = scanReporting(repoPath, credentials);
  const publicCreds = credentials.map(({ _index, _match, _quote, ...f }) => f);
  return {
    credentials: publicCreds,
    reporting,
    summary: `${credentials.length} hard-coded credential(s) (${credentials.filter((c) => c.autoFix).length} auto-fixable), ${reporting.length} external reporting integration(s)`,
  };
}
