// A record of what was done for a repo (analysis, YAML, checks, runs, fixes), as a Confluence page
// (storage format) and as Markdown for a preview. Everything is masked: no keys, usernames or emails.

import { mask, maskKeepRefs } from "./feedback.js";
import { fwName, toolName, langName } from "./names.js";

const STATUS = {
  passed: ["Green", "PASSED"],
  "passed-with-failures": ["Yellow", "PASSED, SOME TESTS FAILED"],
  "test-failures": ["Red", "TEST FAILURES"],
  fixable: ["Yellow", "FIXABLE"],
  "fixable-tests": ["Yellow", "FIXABLE"],
  "needs-input": ["Yellow", "NEEDS INPUT"],
  "needs-attention": ["Red", "NEEDS ATTENTION"],
  "auth-error": ["Red", "AUTH ERROR"],
  running: ["Blue", "RUNNING"],
  stopped: ["Grey", "STOPPED"],
  unknown: ["Grey", "UNKNOWN"],
};

// YAML for a document: credentials only as references
export const maskYaml = (y) => maskKeepRefs(String(y || "").replace(/^(\s*(LT_USERNAME|LT_ACCESS_KEY):\s*)(?!\$\{\{).+$/gm, (_, k, name) => `${k}\${{ .secrets.${name} }}`));

const x = (s) => maskKeepRefs(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cdata = (s) => `<![CDATA[${String(s).split("]]>").join("]]]]><![CDATA[>")}]]>`;
const lozenge = (colour, label) => `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">${colour}</ac:parameter><ac:parameter ac:name="title">${x(label)}</ac:parameter></ac:structured-macro>`;
const status = (st) => lozenge(...(STATUS[st] || STATUS.unknown));
const code = (lang, body, title) => `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${lang}</ac:parameter>${title ? `<ac:parameter ac:name="title">${x(title)}</ac:parameter>` : ""}<ac:parameter ac:name="linenumbers">true</ac:parameter><ac:plain-text-body>${cdata(body)}</ac:plain-text-body></ac:structured-macro>`;
const panel = (kind, html) => `<ac:structured-macro ac:name="${kind}"><ac:rich-text-body>${html}</ac:rich-text-body></ac:structured-macro>`;
const table = (head, rows) => `<table><tbody><tr>${head.map((h) => `<th>${x(h)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
const link = (url, label) => (url ? `<a href="${x(url)}">${x(label || url)}</a>` : "");
const md = (s) => maskKeepRefs(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

const testsLine = (p) => {
  const t = p?.tests || {};
  const parts = [t.classCount && `${t.classCount} test classes (${t.methodCount || 0} methods)`, t.featureCount && `${t.featureCount} features (${t.scenarioCount || 0} scenarios)`, !t.classCount && t.fileCount && `${t.fileCount} test files`].filter(Boolean);
  return parts.join(", ") || "none found";
};

// session = { repoName, profile (summarizeProfile), yaml, yamlFile, validation, options, runs[], activity[],
//             connection[], scan, team, learned[], author }
export function buildSetupReport(session, { title } = {}) {
  const s = session;
  const p = s.profile || {};
  const runs = s.runs || [];
  const last = runs[runs.length - 1];
  const when = new Date();
  const stamp = when.toISOString().slice(0, 16).replace("T", " ");
  const pageTitle = title || `HyperExecute setup: ${s.repoName} (${stamp})`;
  const fw = p.primaryFramework ? fwName(p.primaryFramework) : "unknown framework";
  const stack = [langName(p.language), toolName(p.buildTool || p.packageManager)].filter(Boolean).join(" · ");
  const opts = s.options || {};
  const yamlDoc = maskYaml(s.yaml || "");
  const yamlVersion = (yamlDoc.match(/^version:\s*["']?([\d.]+)/m) || [])[1] || opts.yamlVersion || "?";
  const runson = (yamlDoc.match(/^runson:\s*(.+)$/m) || [])[1] || opts.runson || "linux";
  const concurrency = (yamlDoc.match(/^concurrency:\s*(\d+)/m) || [])[1] || opts.concurrency || "?";
  const finalStatus = last?.status || "not run yet";

  // ---------- Confluence ----------
  const h = [];
  h.push(panel("info", `<p><strong>HyperExecute setup for ${x(s.repoName)}</strong>: ${x(fw)}${stack ? ` (${x(stack)})` : ""}. Last run: ${last ? status(last.status) : "<em>not run yet</em>"}${last?.jobUrl ? ` · ${link(last.jobUrl, "open the job")}` : ""}</p><p>Recorded by HyperExecute Studio on ${x(stamp)} UTC${s.author ? ` for ${x(s.author)}` : ""}. Credentials are shown only as secret references.</p>`));

  h.push("<h2>At a glance</h2>");
  h.push(table(["Item", "Value"], [
    ["Repository", x(s.repoName)],
    ["Language / build", x(stack || "?")],
    ["Framework", x(fw)],
    ["Tests found", x(testsLine(p))],
    ["YAML", `${x(s.yamlFile || "hyperexecute.yaml")} · v${x(yamlVersion)}`],
    ["Runs on", `${x(runson)} · ${x(concurrency)} parallel VMs${opts.splitBy ? ` · split by ${x(opts.splitBy)}` : ""}`],
    ["Validation", s.validation ? (s.validation.valid ? lozenge("Green", "VALID") : `${lozenge("Red", "ERRORS")} ${x(s.validation.errors?.join("; "))}`) : "not checked"],
    ["Runs", runs.length ? `${runs.length} attempt${runs.length === 1 ? "" : "s"}, last ${status(finalStatus)}` : "none yet"],
  ]));

  if (s.activity?.length) {
    h.push("<h2>What was done</h2>");
    h.push(`<ol>${s.activity.map((a) => `<li><strong>${x(a.step)}</strong>${a.detail ? `: ${x(a.detail)}` : ""} <em>(${x(new Date(a.at).toISOString().slice(11, 16))})</em></li>`).join("")}</ol>`);
  }

  if (runs.length) {
    h.push("<h2>Runs</h2>");
    h.push(table(["Attempt", "Status", "Tests", "Duration", "Job", "Changes made before the next attempt"], runs.map((r) => [
      x(`${r.attempt}${r.targeted ? " (affected tests only)" : ""}`),
      status(r.status),
      x(r.tests?.total ? `${r.tests.passed}/${r.tests.total} passed` : "—"),
      x(r.durationSec != null ? `${Math.floor(r.durationSec / 60)}m ${r.durationSec % 60}s` : "—"),
      link(r.jobUrl, "job") || "—",
      r.changes?.length ? `<ul>${r.changes.map((c) => `<li>${x(c)}</li>`).join("")}</ul>` : "—",
    ])));
  }

  const problems = runs.filter((r) => r.problems?.length);
  if (problems.length) {
    h.push("<h2>Problems and how they were fixed</h2>");
    for (const r of problems) {
      h.push(`<h3>Attempt ${x(r.attempt)}: ${status(r.status)}</h3><ul>${r.problems.map((d) => `<li><strong>${x(d.title)}</strong>${d.why ? `: ${x(d.why)}` : ""}${d.fixSummary ? `<br/>Fix: ${x(d.fixSummary)}` : ""}</li>`).join("")}</ul>`);
      if (r.headline) h.push(code("text", mask(r.headline), "Error"));
    }
  }

  if (s.learned?.length) {
    h.push("<h2>Learned from this session</h2>");
    h.push(panel("tip", `<p>These fixes made the next run pass. The agent now suggests them first when the same failure comes back (saved in the repo's <code>.hyperexecute/team.json</code>).</p>`));
    for (const l of s.learned) {
      h.push(`<p><strong>${x(l.title || l.headline || "Failure")}</strong> (${x(l.how === "rules" ? "fixed by a built-in rule" : l.how === "ai" ? "fixed with the AI's change" : "fixed with a manual YAML change")})</p>`);
      const diff = [...(l.change?.removed || []).map((c) => `- ${c}`), ...(l.change?.added || []).map((c) => `+ ${c}`)].join("\n");
      if (diff) h.push(code("diff", diff, "YAML change"));
    }
  }

  h.push("<h2>HyperExecute YAML</h2>");
  h.push(yamlDoc.trim() ? code("yaml", yamlDoc.trimEnd(), s.yamlFile || "hyperexecute.yaml") : "<p><em>No YAML yet.</em></p>");
  if (s.validation?.warnings?.length) h.push(`<p>Warnings:</p><ul>${s.validation.warnings.map((w) => `<li>${x(w)}</li>`).join("")}</ul>`);

  if (s.connection?.length) {
    h.push("<h2>Grid connection</h2>");
    h.push(table(["Where", "Kind", "On LambdaTest"], s.connection.slice(0, 15).map((c) => [`<code>${x(c.file)}:${x(c.line)}</code>`, x(c.kind), c.usesLambdaTest ? lozenge("Green", "YES") : lozenge("Grey", "NO")])));
  }

  if (s.scan) {
    h.push("<h2>Credentials and reporting</h2>");
    h.push(`<ul><li>Hard-coded LambdaTest credentials: ${x(s.scan.credentials ?? 0)}${s.scan.credentialsFixed ? ` (${x(s.scan.credentialsFixed)} moved to environment variables)` : ""}</li>${s.scan.reporting?.length ? `<li>Reports to: ${x(s.scan.reporting.join(", "))}</li>` : ""}</ul>`);
  }

  if (s.team && (s.team.notes?.length || Object.keys(s.team.options || {}).length)) {
    h.push("<h2>Team decisions for this repo</h2>");
    if (Object.keys(s.team.options || {}).length) h.push(table(["Setting", "Value"], Object.entries(s.team.options).map(([k, v]) => [`<code>${x(k)}</code>`, x(typeof v === "object" ? JSON.stringify(v) : v)])));
    if (s.team.notes?.length) h.push(`<ul>${s.team.notes.map((n) => `<li>${x(n)}</li>`).join("")}</ul>`);
  }

  h.push("<h2>Next steps</h2>");
  h.push(`<ul>${nextSteps(s).map((n) => `<li>${x(n)}</li>`).join("")}</ul>`);

  // ---------- Markdown preview ----------
  const m = [];
  m.push(`# ${pageTitle}`, "", `> HyperExecute setup for **${md(s.repoName)}**: ${md(fw)}${stack ? ` (${md(stack)})` : ""}. Last run: **${md(finalStatus)}**${last?.jobUrl ? ` · [job](${last.jobUrl})` : ""}`, "");
  m.push("## At a glance", "", "| Item | Value |", "|---|---|", `| Tests found | ${md(testsLine(p))} |`, `| YAML | ${md(s.yamlFile || "hyperexecute.yaml")} · v${md(yamlVersion)} |`, `| Runs on | ${md(runson)} · ${md(concurrency)} VMs |`, `| Validation | ${s.validation ? (s.validation.valid ? "valid" : "errors") : "not checked"} |`, `| Runs | ${runs.length} |`, "");
  if (s.activity?.length) m.push("## What was done", "", ...s.activity.map((a, i) => `${i + 1}. **${md(a.step)}**${a.detail ? `: ${md(a.detail)}` : ""}`), "");
  if (runs.length) m.push("## Runs", "", "| # | Status | Tests | Changes |", "|---|---|---|---|", ...runs.map((r) => `| ${r.attempt} | ${md(r.status)} | ${r.tests?.total ? `${r.tests.passed}/${r.tests.total}` : "—"} | ${md((r.changes || []).join("; ")) || "—"} |`), "");
  if (s.learned?.length) m.push("## Learned from this session", "", ...s.learned.map((l) => `- ${md(l.title || l.headline)}: ${md([...(l.change?.added || [])].slice(0, 3).join("; "))}`), "");
  m.push("## HyperExecute YAML", "", "```yaml", yamlDoc.trimEnd(), "```", "", "## Next steps", "", ...nextSteps(s).map((n) => `- ${md(n)}`));

  return { title: pageTitle, storage: h.join("\n"), markdown: m.join("\n") };
}

function nextSteps(s) {
  const last = s.runs?.[s.runs.length - 1];
  const out = [];
  if (!s.yaml) out.push("Generate and validate the HyperExecute YAML.");
  else if (s.validation && !s.validation.valid) out.push("Fix the YAML validation errors above.");
  if (!last) out.push("Run the job once and check that the discovered test count matches the repo.");
  else if (last.status === "passed") out.push("Commit the YAML (credentials as secret references) and add a CI pipeline so every push runs on HyperExecute.");
  else if (last.status === "test-failures" || last.status === "passed-with-failures") out.push("The remaining failures are in the tests or the application, not the YAML: share them with the test owners.");
  else if (last.status === "auth-error") out.push("Check the LambdaTest username and access key used for the run.");
  else out.push("Review the last diagnosis and apply its fix, then rerun.");
  if (s.connection?.some((c) => !c.usesLambdaTest)) out.push("Point the connection points marked NO at the LambdaTest grid.");
  if (s.scan && s.scan.credentials > (s.scan.credentialsFixed || 0)) out.push("Move the remaining hard-coded credentials to environment variables.");
  return out;
}
