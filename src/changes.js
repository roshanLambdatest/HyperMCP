// What a chat turn changed, in a form people can learn from: the option changes with a short
// "why" for each, a line diff of the YAML, and the validation result after the change.
// Shared by the VS Code extension's chat and the web version's chat.

// Why each generator option matters on HyperExecute. Used when the AI gives no explanation
// (offline rules, built-in assistant) and as the fallback for keys it skips.
const SPLIT_WHY = {
  class: "each test class becomes its own task, so classes run in parallel across VMs",
  method: "each test method becomes its own task: the finest split, best when a few classes hold most of the tests",
  suite: "each TestNG suite file becomes a task, keeping the suite's own setup and ordering together",
  file: "each spec file becomes a task, the natural unit for JS/Python runners",
  feature: "each Cucumber feature file becomes a task, keeping a feature's scenarios on one VM",
  scenario: "each Cucumber scenario becomes its own task, so one slow feature can't hold back the job",
  tag: "each tag becomes a task, so only the tagged tests run, grouped by tag",
  none: "no splitting: the whole suite runs as one task",
};

const WHY = {
  framework: () => "The framework decides how tests are discovered and which runner command each task uses.",
  yamlVersion: (v) =>
    v === "0.2"
      ? "v0.2 uses the framework: block, so HyperExecute discovers the tests itself. It never contains testDiscovery, and it can't do matrix, tag/file/feature/scenario splits or custom commands."
      : v === "0.1"
        ? "v0.1 spells out testDiscovery and testRunnerCommand, so it can do matrix mode, tag/file/feature/scenario splits and custom commands."
        : "auto picks v0.2 when the framework supports it, else v0.1.",
  runson: (v) => `The OS of every VM the job runs on (${v}).`,
  runsonMatrix: () => "Each listed OS becomes a matrix axis, so the whole suite runs once per OS.",
  executionMode: (v) =>
    v === "matrix"
      ? "Matrix mode runs every combination of the matrix axes (OS, browser, tags…) as its own task."
      : "Autosplit discovers the tests and spreads them over the VMs to finish as fast as possible.",
  splitBy: (v) => `Split by ${v}: ${SPLIT_WHY[v] || "decides what one task is"}.`,
  concurrency: (v) => `Up to ${v} VMs run tasks at the same time. More VMs finish sooner but use more of the account's parallel limit.`,
  retryOnFailure: (v) => (v ? "Failed tasks are retried, which hides flaky failures (and costs time when a test is really broken)." : "No retries: every failure is reported as is."),
  maxRetries: (v) => `A failed task is retried up to ${v} time(s) before it is reported as failed.`,
  globalTimeout: (v) => `The job is stopped after ${v} minutes so a hung test can't hold VMs forever.`,
  matrixValues: () => "The values the job is split over (for example tags). Each one becomes a task.",
  extraMatrix: () => "Extra matrix axes. Each value becomes an environment variable your tests read, e.g. which browser to start.",
  extraEnv: () => "Environment variables set on every VM. Secrets belong in ${{ .secrets.NAME }}, never inline.",
  extraPre: () => "Commands that run once per VM before the tests, e.g. installing dependencies.",
  post: () => "Commands that run after the tests, e.g. collecting reports.",
  runnerCommand: () => "The command each task runs; $test is replaced with the task's tests.",
  discoveryCommand: () => "The command that lists the tests to split. If it prints nothing, the job runs 0 tests.",
  discoveryMode: (v) => (v === "remote" ? "Tests are discovered on a HyperExecute VM, so local tools aren't needed." : "Tests are discovered on the machine that runs the CLI, before upload."),
  runnerClass: () => "The class that starts the tests (e.g. a Cucumber runner) when the framework needs one.",
  groups: () => "Only these TestNG groups run.",
  flags: () => "Extra flags passed to the build tool on every run.",
  tunnel: (v) => (v ? "The LambdaTest tunnel lets the VMs reach apps on a private network or localhost." : "No tunnel: the VMs can only reach public URLs."),
  jobLabel: () => "Labels make the job easy to find and filter on the HyperExecute dashboard.",
};

export function fmt(v) {
  if (v === undefined || v === null || v === "") return "default";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return Object.entries(v).map(([k, x]) => `${k}=${Array.isArray(x) ? x.join("|") : x}`).join(", ");
  return String(v);
}

// Generator option changes between two option sets, each with why it matters.
// `ai` holds the model's explanations ([{ key, why }]); they win over the table.
export function optionChanges(before = {}, after = {}, ai = []) {
  const said = Object.fromEntries((ai || []).filter((e) => e?.key && e?.why).map((e) => [e.key, e.why]));
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => ({ key: k, from: fmt(before[k]), to: fmt(after[k]), why: said[k] || (after[k] === undefined ? "Back to the detected default." : WHY[k]?.(after[k]) || "") }));
}

// Line diff (LCS), trimmed to the changed hunks with one line of context.
export function lineDiff(before = "", after = "", { context = 1, max = 80 } = {}) {
  const a = String(before).split("\n");
  const b = String(after).split("\n");
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ op: " ", text: a[i++] }), j++;
    // removed lines before added ones, like git
    else if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) ops.push({ op: "-", text: a[i++] });
    else ops.push({ op: "+", text: b[j++] });
  }
  const keep = ops.map((o, k) => o.op !== " " || ops.slice(Math.max(0, k - context), k + context + 1).some((x) => x.op !== " "));
  const out = [];
  ops.forEach((o, k) => {
    if (keep[k]) out.push(o);
    else if (out.length && out[out.length - 1].op !== "…") out.push({ op: "…", text: "" });
  });
  while (out.length && out[out.length - 1].op === "…") out.pop();
  const added = ops.filter((o) => o.op === "+").length;
  const removed = ops.filter((o) => o.op === "-").length;
  return { lines: out.slice(0, max), truncated: out.length > max, added, removed };
}

// The validation result as a short summary for the chat.
export function checkSummary(v) {
  if (!v) return null;
  return { valid: !v.errors.length, errors: v.errors.slice(0, 3), moreErrors: Math.max(0, v.errors.length - 3), warnings: v.warnings.length };
}

