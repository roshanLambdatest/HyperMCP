// Line-by-line explanation of a HyperExecute YAML, for people learning how one is built.
// Every line gets what it does on HyperExecute; values that matter (secrets, placeholders, $test,
// OS names, common commands) get a note on the value itself. Used by the VS Code extension
// (Explain tab, hovers, annotated copy) and the web version (Explain tab).
// Facts follow knowledge/yaml-reference.md.

const OS = { linux: "Linux", win: "Windows", win11: "Windows 11", mac: "macOS", mac13: "macOS 13" };
const s = (v) => String(v ?? "").trim();
const unq = (v) => s(v).replace(/^(['"])(.*)\1$/, "$2");

// what a shell command in pre/post/testSuites/runner does, for the usual build tools
function command(c) {
  const t = unq(c);
  const notes = [];
  if (/^cd\s+\S+\s*&&/.test(t)) notes.push(`first moves into \`${t.match(/^cd\s+(\S+)/)[1]}\` (the project isn't at the repo root)`);
  if (/\bmvn\b.*\b(install|test-compile|dependency:resolve|dependency:go-offline)\b/.test(t) && /skipTests|maven\.test\.skip|dependency:/.test(t)) notes.push("downloads the Maven dependencies and compiles, without running tests, so the test tasks start fast");
  else if (/\bmvn\b.*\btest\b/.test(t)) notes.push("runs the tests with Maven (Surefire)");
  if (/gradlew?\b.*\b(compileTestJava|testClasses|assemble|build)\b/.test(t) && !/\btest\b(?!Classes)/.test(t)) notes.push("downloads the Gradle dependencies and compiles the tests");
  else if (/gradlew?\b.*\btest\b/.test(t)) notes.push("runs the tests with Gradle");
  if (/maven\.repo\.local=\$CACHE_DIR/.test(t)) notes.push("`-Dmaven.repo.local=$CACHE_DIR` keeps Maven's downloads in the cached folder");
  if (/\bnpm ci\b/.test(t)) notes.push("installs the exact Node dependencies from the lockfile");
  else if (/\b(npm|yarn|pnpm) (install|i)\b/.test(t)) notes.push("installs the Node dependencies");
  if (/playwright install/.test(t)) notes.push("downloads the browsers Playwright drives");
  if (/\bnpx playwright test\b/.test(t)) notes.push("runs Playwright tests");
  if (/\bnpx cypress run\b/.test(t)) notes.push("runs Cypress tests");
  if (/\bpip3? install\b/.test(t)) notes.push("installs the Python dependencies");
  if (/\b(python3? -m )?pytest\b/.test(t)) notes.push("runs the tests with pytest");
  if (/\bdotnet (build|restore)\b/.test(t)) notes.push("restores and builds the .NET test project");
  if (/\bdotnet test\b/.test(t)) notes.push("runs the .NET tests");
  if (/-Dtest="?\$test"?/.test(t)) notes.push("`-Dtest=\"$test\"` runs only the test class (or method) this task was given");
  if (/cucumber\.features="?\$test"?/.test(t)) notes.push("`-Dcucumber.features=\"$test\"` runs only the feature (or scenario) this task was given");
  if (/-Dgroups=/.test(t)) notes.push("`-Dgroups` limits the run to the listed TestNG groups");
  if (/\s-P\S+/.test(t)) notes.push(`\`${t.match(/\s(-P\S+)/)[1]}\` turns on that Maven profile`);
  if (/\$test\b/.test(t) && !notes.some((n) => n.includes("$test"))) notes.push("`$test` is replaced with the test (or matrix value) this task runs");
  if (/^ls\b/.test(t)) notes.push("lists the working folder in the task log, which helps when looking for report files");
  return notes.length ? ` This one ${notes.join("; ")}.` : "";
}

function envValue(name, v) {
  const t = unq(v);
  if (/\$\{\{\s*\.secrets\.(\w+)\s*\}\}/.test(t)) return ` The value is a secret reference: HyperExecute fills it in from Settings → Secrets (\`${t.match(/\.secrets\.(\w+)/)[1]}\`), so the value never sits in the file.`;
  if (/^<set\b/.test(t)) return " The value is a placeholder: fill it in before running, or the tests get the literal text.";
  if (name === "CACHE_DIR") return " It names the folder that dependencies are downloaded into; `cacheDirectories` keeps that folder between runs.";
  if (name === "GRADLE_USER_HOME") return " Points Gradle's download cache at a folder the job caches between runs.";
  if (/^LT_(USERNAME|ACCESS_KEY)$/.test(name)) return " The LambdaTest account the tests use to open browsers on the grid. Here it is written in the file: don't commit it to a shared repo.";
  return "";
}

// key path → explanation; "*" matches any key at that level. A function gets (value, ctx).
const KEYS = {
  version: (v) => `Which YAML format this is. ${unq(v) === "0.2" ? "v0.2 uses HyperExecute's native runner (the `framework:` block): HyperExecute finds the tests itself. It has no matrix mode and no custom commands, and must never contain `testDiscovery`, or the job runs 0 tests." : "v0.1 spells out how to find the tests (`testDiscovery`) and how to run one (`testRunnerCommand`), so it can do matrix runs, tag/file/feature/scenario splits and custom commands."}`,
  runson: (v) => /matrix\.os/.test(s(v)) ? "The OS of each task, taken from the `os` matrix axis, so the suite runs once per OS." : `The operating system of every VM in the job: ${OS[unq(v)] || unq(v)}. Allowed values: linux, win, win11, mac, mac13.`,
  autosplit: (v) => v === "true" || v === true ? "Autosplit mode: HyperExecute lists the tests (the discovery step), then spreads them over the VMs, balancing by how long each took last time. The usual default." : "Autosplit is off: tasks come from the matrix instead.",
  concurrency: (v) => `How many VMs run at the same time: ${unq(v)}. More VMs finish sooner, up to the number of tests there are to split, and count against your account's parallel limit.`,
  parallelism: "How many tasks each matrix combination is split into.",
  retryOnFailure: (v) => v === "true" || v === true ? "Failed tests are run again, to absorb flaky failures. A test that keeps failing is still reported as failed." : "Failed tests are not retried.",
  maxRetries: (v) => `How many times a failed test is retried: ${unq(v)} (1 to 5).`,
  globalTimeout: (v) => `The whole job is stopped after ${unq(v)} minutes (1 to 150), so a hung test can't hold VMs forever.`,
  testSuiteTimeout: (v) => `One task (one VM's share of the tests) is stopped after ${unq(v)} minutes.`,
  testSuiteStep: (v) => `One step of a task is stopped after ${unq(v)} minutes.`,
  idleTimeout: (v) => `A task with no output for ${unq(v)} seconds is stopped. Raised for Selenium tests that wait a long time on the browser.`,
  scenarioCommandStatusOnly: "A task's pass/fail comes from the test command's exit code alone, not from post steps such as listing files.",
  frameworkStatusOnly: "A task's pass/fail comes from the test framework's results only.",
  tunnel: (v) => v === "true" || v === true ? "Starts a LambdaTest tunnel for the job, so tests on HyperExecute VMs can reach internal, staging or localhost URLs." : "No tunnel: the tests can only reach public URLs.",
  tunnelOpts: "Settings for the tunnel (extra arguments, a global tunnel, the system proxy).",
  tunnelNames: "Reuse tunnels that are already running, by name, instead of starting a new one.",
  runtime: "The language and version installed on every VM before anything else runs.",
  "runtime.language": (v) => `The language to install: ${unq(v)}.`,
  "runtime.version": (v) => `The version of it: ${unq(v)}. Match what the project builds with locally.`,
  env: "Environment variables set on every VM. The tests and every command can read them.",
  "env.*": (v, ctx) => `The environment variable \`${ctx.key}\`.${envValue(ctx.key, v)}`,
  vars: "Variables for the YAML itself (not set as environment variables).",
  cacheKey: (v) => `The name of the dependency cache. ${/checksum "([^"]+)"/.test(s(v)) ? `It's a checksum of \`${s(v).match(/checksum "([^"]+)"/)[1]}\`: while that file doesn't change, runs reuse the cached downloads; when it changes, the cache is rebuilt.` : "Runs with the same key reuse the cached folders."}`,
  cacheDirectories: "The folders kept between runs (usually the dependency downloads), so the next run doesn't download everything again.",
  pre: "Commands every VM runs once before its tests: installing dependencies and compiling.",
  post: "Commands every VM runs after its tests, for example to collect or list report files.",
  globalPre: "Commands that run once for the whole job, before any VM starts its tests.",
  globalPost: "Commands that run once for the whole job, after all tests finish.",
  testDiscovery: "How autosplit finds the tests: a command whose output (one test per line) becomes the list of things to split over the VMs.",
  "testDiscovery.type": (v) => unq(v) === "raw" ? "`raw`: each line the command prints is one test, used exactly as printed." : `The discovery type: ${unq(v)}.`,
  "testDiscovery.mode": (v) => unq(v) === "local" ? "`local`: discovery runs on the machine that starts the job (your computer or CI) before the upload. Safest when the command uses grep/sed and the VMs run Windows." : unq(v) === "remote" ? "`remote`: discovery runs on a HyperExecute VM after the upload, so nothing is needed locally." : `Where discovery runs: ${unq(v)}.`,
  "testDiscovery.command": (v) => `The command that lists the tests. It must print one test per line and nothing else; if it prints nothing, the job runs 0 tests.${/grep/.test(s(v)) && /\.java/.test(s(v)) ? " This one searches the Java test folder for files with @Test and turns each path into a class name (com.acme.LoginTest)." : /\.feature/.test(s(v)) ? " This one lists the Cucumber feature files." : /--list|--collect-only/.test(s(v)) ? " This one asks the test runner itself for its list of tests." : ""}`,
  testRunnerCommand: (v) => `The command each task runs for its share of the tests.${command(v)}`,
  linuxTestRunnerCommand: (v) => `The runner command on Linux VMs.${command(v)}`,
  winTestRunnerCommand: (v) => `The runner command on Windows VMs.${command(v)}`,
  macTestRunnerCommand: (v) => `The runner command on macOS VMs.${command(v)}`,
  matrix: "Matrix mode: every combination of the values below becomes its own task. Each axis is also an environment variable the tests can read.",
  "matrix.*": (v, ctx) => ctx.key === "os" ? "The OS axis: the suite runs once per OS listed (used by `runson: ${matrix.os}`)." : `A matrix axis: one task per value; \`testSuites\` reads it as \`$${ctx.key}\` and the tests as the environment variable \`${ctx.key}\`.${ctx.key === "tag" ? " Here each value is a tag, so each tag's tests run as one task." : ctx.key === "test" ? " Here each value is a test class." : ctx.key === "browser" ? " Here each value is a browser, so the suite runs once per browser." : ctx.key === "project" ? " Here each value is a Playwright project." : ""}`,
  exclusionMatrix: "Combinations of matrix values to skip.",
  combineTasksInMatrixMode: "Runs several matrix combinations in one task to save VMs.",
  testSuites: "In matrix mode, the command each task runs; `$<axis>` is replaced with that task's matrix value.",
  framework: "YAML v0.2's native runner: HyperExecute discovers the tests with the build tool itself and splits them. No `testDiscovery` here.",
  "framework.name": (v) => `Which runner: ${unq(v)} (build tool / test framework).`,
  "framework.discoveryMode": (v) => unq(v) === "remote" ? "Discovery runs on a HyperExecute VM." : "Discovery runs on the machine that starts the job.",
  "framework.discoveryType": (v) => ({ method: "Splits by test method: the finest split.", class: "Splits by test class: each class stays on one VM (needed when tests in a class share state).", xmltest: "Splits by `<test>` block of the TestNG suite XML." })[unq(v)] || `How tests are split: ${unq(v)}.`,
  "framework.baseCommand": (v) => `The command that replaces the plain \`mvn test\` / \`gradle test\`: ${unq(v)}. It must start with the build tool.`,
  "framework.flags": "Extra arguments for both discovery and the test run, e.g. `-P` profiles or `-D` properties.",
  "framework.discoveryFlags": "Arguments for discovery only, e.g. `-Dgroups=smoke` to find only one group.",
  "framework.runnerFlags": "Arguments for the test run only.",
  "framework.workingDirectory": "The folder (inside the repo) the build runs in.",
  mergeArtifacts: "Combines the files every VM uploads into one download per artefact name.",
  uploadArtefacts: "Files kept after the job for download from the dashboard, such as reports and screenshots. (Spelled `uploadArtefacts`, with the British spelling.)",
  "uploadArtefacts[].name": (v) => `The name this download gets on the dashboard: ${unq(v)}.`,
  "uploadArtefacts[].path": "The files to keep; `**` matches every file in the folders below.",
  report: "Builds one HyperExecute report from every VM's results.",
  partialReports: "Where each VM's test results are and what format they're in, so they can be merged into the job report.",
  "partialReports.location": (v) => `The folder the framework writes its results to: ${unq(v)}.`,
  "partialReports.type": (v) => `The results' format: ${unq(v)}.`,
  "partialReports.frameworkName": (v) => `Which framework wrote them: ${unq(v)}, so HyperExecute reads them correctly.`,
  errorCategorizedReport: "Groups failures in the report by error type.",
  failFast: "Stops the job early after a number of failures, instead of running everything.",
  "failFast.maxNumberOfTests": (v) => `How many failures stop the job: ${unq(v)}.`,
  "failFast.level": (v) => `What a failure is counted per: ${unq(v)}.`,
  retryOptions: "Narrows which failures are retried.",
  "retryOptions.errorRegexps": "Only failures whose error matches one of these patterns are retried.",
  jobLabel: "Labels shown on the dashboard, to find and filter jobs. `high`, `medium` and `low` also set the job's priority.",
  project: "The HyperExecute project this job belongs to.",
  buildConfig: "Settings for the build name shown on the dashboard.",
  background: "Commands started in the background before the tests, e.g. the app under test, which keep running during the tests.",
  backgroundDirectives: "Background commands with extra settings (when to stop them, retries).",
  hostsOverride: "Extra entries for the VMs' hosts file, so a host name points to the IP you give.",
  differentialUpload: "Uploads only the files that changed since the last run, to start jobs faster.",
  base: "Inherits settings from shared YAML files.",
  dynamicAllocation: "Lets HyperExecute decide how many VMs to use for the job.",
  alwaysRunPostSteps: "Runs the post commands even when the tests fail.",
  preDirectives: "Pre commands with retries, for steps that sometimes fail (e.g. downloads).",
  postDirectives: "Post commands with extra settings.",
  sourcePayload: "Downloads the code from a URL on the VMs instead of uploading it from this machine.",
  captureScreenRecordingForScenarios: "Records the screen for each scenario.",
  cypress: "Native Cypress mode.",
  cypressOps: "Settings for native Cypress mode.",
  workingDirectory: "The folder the commands run in.",
  shell: "The shell the commands run in.",
  dataJsonPath: "A JSON file of data sets; each one becomes a run (data-driven testing).",
  smartGrid: "Settings for the LambdaTest browser grid used by the tests.",
};

// list items: parent path → explanation of one item
const ITEMS = {
  pre: (v) => `Runs on every VM before the tests.${command(v)}`,
  post: (v) => `Runs on every VM after the tests.${command(v)}`,
  globalPre: (v) => `Runs once before the job.${command(v)}`,
  globalPost: (v) => `Runs once after the job.${command(v)}`,
  testSuites: (v) => `The command each matrix task runs.${command(v)}`,
  cacheDirectories: (v) => /CACHE_DIR/.test(s(v)) ? "The folder named by `CACHE_DIR`, where the dependencies are downloaded." : `A folder kept between runs: ${unq(v)}.`,
  "matrix.*": (v, ctx) => `One value of the \`${ctx.parentKey}\` axis: ${ctx.parentKey === "os" ? OS[unq(v)] || unq(v) : unq(v)}. It gets its own task.`,
  "uploadArtefacts[].path": (v) => `Keeps the files matching \`${unq(v)}\`.`,
  "framework.flags": (v) => `Passed to the build tool: \`${unq(v)}\`.${/^-P/.test(unq(v)) ? " Turns on that Maven profile." : /^-D/.test(unq(v)) ? " Sets a system property the tests can read." : ""}`,
  jobLabel: (v) => `The label \`${unq(v)}\`.`,
  "retryOptions.errorRegexps": (v) => `Retry when the error matches \`${unq(v)}\`.`,
  background: (v) => `Started in the background before the tests.${command(v)}`,
};

const wild = (p) => p.replace(/\.[^.[\]]+$/, ".*");
function lookup(table, path) {
  if (table[path]) return table[path];
  if (table[wild(path)]) return table[wild(path)];
  return null;
}

// Explains each line. Returns [{ n, text, kind, path, what }], kind: key | item | comment | blank | doc | continued.
export function explainYamlLines(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  const stack = []; // { indent, path, list? }
  let block = null; // indent of a block scalar (| or >) whose lines follow
  lines.forEach((raw, i) => {
    const n = i + 1;
    const trimmed = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    if (block !== null) {
      if (!trimmed || indent > block) return out.push({ n, text: raw, kind: "continued", what: "" });
      block = null;
    }
    if (!trimmed) return out.push({ n, text: raw, kind: "blank", what: "" });
    if (trimmed === "---") return out.push({ n, text: raw, kind: "doc", what: "Marks the start of the YAML document (optional)." });
    if (trimmed.startsWith("#")) {
      const what = /^#\s*Run:/.test(trimmed) ? "A comment with the command that runs this file with the HyperExecute CLI." : i < 6 && /generated|Framework:|YAML \d|Mode:/.test(trimmed) ? "A comment the generator wrote about this file. Comments are ignored by HyperExecute." : "A comment: ignored by HyperExecute.";
      return out.push({ n, text: raw, kind: "comment", what });
    }
    const item = trimmed.startsWith("- ") || trimmed === "-";
    // close the levels this line is not inside of; a list may sit at its key's own indent
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.indent < indent || (item && top.indent === indent && top.emptyKey)) break;
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    const parentPath = parent?.path || "";
    const parentKey = parentPath.split(/[.[]/).filter(Boolean).pop()?.replace("]", "") || "";
    let body = trimmed;
    let path = parentPath;
    if (item) {
      body = trimmed.slice(1).trim();
      path = `${parentPath}[]`;
      const kv = body.match(/^([A-Za-z_][\w.-]*):(?:\s+(.*))?$/);
      if (!kv) {
        const f = lookup(ITEMS, parentPath);
        const what = f ? f(body, { parentKey, key: parentKey }) : `One entry of \`${parentKey}\`: ${unq(body)}.`;
        return out.push({ n, text: raw, kind: "item", path, what });
      }
      stack.push({ indent: indent + 1, path }); // the item's own keys sit at indent + 2
    }
    const m = body.match(/^("[^"]+"|'[^']+'|[^:#][^:]*?):(?:\s+(.*))?$/);
    if (!m) return out.push({ n, text: raw, kind: "continued", what: "" });
    const key = unq(m[1]);
    const value = (m[2] || "").replace(/\s+#.*$/, "");
    const keyIndent = item ? indent + 2 : indent;
    const full = path ? `${path}.${key}` : key;
    if (!value || /^[|>][-+]?$/.test(value)) {
      if (value) block = keyIndent;
      else stack.push({ indent: keyIndent, path: full, emptyKey: true });
    }
    const f = lookup(KEYS, full);
    let what = f ? (typeof f === "function" ? f(value, { key, parentKey }) : f) : null;
    if (!what) what = parentPath ? `\`${key}\` inside \`${parentKey}\`.` : "Not a key this explainer knows. Check it against the HyperExecute YAML docs (the Checks tab flags misspelled keys).";
    out.push({ n, text: raw, kind: item ? "item" : "key", path: full, what });
  });
  return out;
}

// The YAML with a comment above each explained line, so the file itself teaches. Still a valid YAML.
export function annotateYaml(text, { width = 100 } = {}) {
  const wrap = (str, pad) => {
    const words = str.split(/\s+/);
    const rows = [];
    let row = "";
    for (const w of words) {
      if (row && (pad + 2 + row.length + 1 + w.length) > width) { rows.push(row); row = w; } else row = row ? `${row} ${w}` : w;
    }
    if (row) rows.push(row);
    return rows.map((r) => `${" ".repeat(pad)}# ${r}`);
  };
  const out = [];
  for (const l of explainYamlLines(text)) {
    if ((l.kind === "key" || l.kind === "item") && l.what) out.push(...wrap(l.what, l.text.length - l.text.trimStart().length));
    out.push(l.text);
  }
  return out.join("\n");
}
