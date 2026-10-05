// End-to-end smoke test: spawns the MCP server over stdio and exercises every tool against the fixtures.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import YAML from "yaml";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Keep feedback, dry-run history and the Confluence cache out of the real ~/.hyperexecute-studio
{
  const os = await import("node:os");
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "he-state-"));
  Object.assign(process.env, { HE_FEEDBACK_DIR: path.join(state, "feedback"), HE_STATE_DIR: state, HE_KB_CACHE_DIR: path.join(state, "kb-cache"), HE_LEARN: "off" });
}
const fx = (n) => path.join(here, "fixtures", n);

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [path.join(here, "..", "src", "index.js")], env: { ...process.env, ATLASSIAN_API_TOKEN: "", LT_USERNAME: "tester", LT_ACCESS_KEY: "test-key-123", HE_CLI_PATH: path.join(here, "bin", "fake-hyperexecute.sh") } }));

let failures = 0;
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: r.isError, text: r.content[0].text };
};
const check = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(detail);
  }
};

const tools = (await client.listTools()).tools.map((t) => t.name);
check("tools registered", ["analyze_repo", "generate_hyperexecute_yaml", "validate_hyperexecute_yaml", "dry_run_test_discovery", "search_knowledge_base", "get_confluence_page", "knowledge_base_status", "scan_credentials_and_reporting", "fix_hardcoded_credentials", "generate_lambdatest_capabilities", "optimize_hyperexecute_yaml", "run_hyperexecute_job", "get_hyperexecute_run", "fix_and_rerun_hyperexecute", "diagnose_hyperexecute_logs", "set_lambdatest_credentials", "lambdatest_credentials_status", "remember_for_team", "publish_to_confluence"].every((t) => tools.includes(t)), tools);

// Java TestNG
let a = JSON.parse((await call("analyze_repo", { repoPath: fx("maven-testng") })).text);
check("testng detected", a.primaryFramework === "testng" && a.buildTool === "maven", a);
check("testng classes (abstract base excluded)", a.tests.classCount === 2 && a.tests.methodCount === 3, a.tests);
check("env vars found", ["BASE_URL", "LT_ACCESS_KEY", "LT_USERNAME"].every((v) => a.envVars.includes(v)), a.envVars);
check("java version", a.runtimeVersion === "17", a.runtimeVersion);

let g = await call("generate_hyperexecute_yaml", { repoPath: fx("maven-testng"), yamlVersion: "0.1", concurrency: 3 });
check("testng yaml generated", !g.isError && g.text.includes('-Dtest="$test"') && g.text.includes("autosplit: true"), g.text);
console.log(g.text, "\n");

g = await call("generate_hyperexecute_yaml", { repoPath: fx("maven-testng"), yamlVersion: "0.1", splitBy: "tag" });
check("testng tag matrix", g.text.includes("-Dgroups") && g.text.includes("- smoke") && g.text.includes("- regression"), g.text);
g = await call("generate_hyperexecute_yaml", { repoPath: fx("maven-testng"), yamlVersion: "0.1", splitBy: "suite" });
check("testng suite split uses pom property", g.text.includes('-DsuiteXmlFile="$test"'), g.text);

let d = JSON.parse((await call("dry_run_test_discovery", { repoPath: fx("maven-testng"), command: extract(await call("generate_hyperexecute_yaml", { repoPath: fx("maven-testng"), yamlVersion: "0.1" }), "command") })).text);
check("testng class discovery", d.discovered === 2 && d.items.includes("com.acme.tests.LoginTest"), d);
d = JSON.parse((await call("dry_run_test_discovery", { repoPath: fx("maven-testng"), command: extract(await call("generate_hyperexecute_yaml", { repoPath: fx("maven-testng"), yamlVersion: "0.1", splitBy: "method" }), "command") })).text);
check("testng method discovery", d.discovered === 3 && d.items.includes("com.acme.tests.LoginTest#invalidLogin"), d);

// Cucumber
g = await call("generate_hyperexecute_yaml", { repoPath: fx("maven-cucumber") });
check("cucumber yaml", g.text.includes("-Dtest=TestRunner") && g.text.includes("-Dcucumber.features") && g.text.includes("frameworkName: cucumber") && g.text.includes("target/cucumber-reports/"), g.text);
d = JSON.parse((await call("dry_run_test_discovery", { repoPath: fx("maven-cucumber"), command: extract(await call("generate_hyperexecute_yaml", { repoPath: fx("maven-cucumber"), splitBy: "scenario" }), "command") })).text);
check("cucumber scenario discovery", d.discovered === 2 && d.items[0].endsWith("login.feature:3"), d);

// Playwright
g = await call("generate_hyperexecute_yaml", { repoPath: fx("playwright"), runsonMatrix: ["linux", "win"], executionMode: "matrix" });
check("playwright matrix yaml", g.text.includes("npx playwright test") && g.text.includes("${matrix.os}") && g.text.includes("tests/home.spec.ts"), g.text);
d = JSON.parse((await call("dry_run_test_discovery", { repoPath: fx("playwright"), command: extract(await call("generate_hyperexecute_yaml", { repoPath: fx("playwright") }), "command") })).text);
check("playwright discovery", d.discovered === 2, d);

// pytest
g = await call("generate_hyperexecute_yaml", { repoPath: fx("pytest"), splitBy: "method" });
check("pytest yaml (saved account embedded, key masked in the reply)", g.text.includes("python3 -m pytest") && g.text.includes("LT_USERNAME: tester") && g.text.includes("LT_ACCESS_KEY: tes****") && !g.text.includes("test-key-123"), g.text);
{
  const gr = await call("generate_hyperexecute_yaml", { repoPath: fx("pytest"), embedCredentials: false });
  check("embedCredentials:false keeps secret references", gr.text.includes("${{ .secrets.LT_ACCESS_KEY }}") && !gr.text.includes("LT_USERNAME: tester"), gr.text);
}
d = JSON.parse((await call("dry_run_test_discovery", { repoPath: fx("pytest"), command: extract(g, "command") })).text);
check("pytest method discovery", d.discovered === 2 && d.items.includes("tests/test_login.py::TestCheckout::test_pay"), d);

// Validator
var v = JSON.parse((await call("validate_hyperexecute_yaml", { yamlContent: "version: 0.1\nrunson: ubuntu\nautosplit: true\nconcurency: 2\ntestDiscovery:\n  type: raw\n  mode: remote\n  command: ls\ntestRunnerCommand: mvn test\nenv:\n  API_TOKEN: abc123\n  LT_ACCESS_KEY: abc123\nuploadArtifacts: []\n" })).text);
check("validator catches bad runson / missing $test / typo / secret / spelling",
  v.errors.some((e) => e.includes("runson")) && v.errors.some((e) => e.includes("$test")) && v.warnings.some((w) => w.includes('"concurrency"')) && v.warnings.some((w) => w.includes("API_TOKEN") && w.includes("secret")) && !v.warnings.some((w) => w.includes("LT_ACCESS_KEY")) && v.info.some((i) => i.includes("LT_ACCESS_KEY")) && v.errors.some((e) => e.includes("uploadArtefacts")), v);


// YAML v0.2
g = await call("generate_hyperexecute_yaml", { repoPath: fx("maven-testng") });
check("testng auto → v0.2 framework block", g.text.includes("version: \"0.2\"") && g.text.includes("name: maven/testng") && g.text.includes("discoveryMode: remote") && !/^testDiscovery:/m.test(g.text), g.text);
console.log(g.text, "\n");
g = await call("generate_hyperexecute_yaml", { repoPath: fx("maven-testng"), splitBy: "suite", groups: "smoke" });
check("v0.2 suite → xmltest + groups", g.text.includes("discoveryType: xmltest") && g.text.includes("-Dgroups=smoke"), g.text);
g = await call("generate_hyperexecute_yaml", { repoPath: fx("maven-testng"), executionMode: "matrix", yamlVersion: "0.2" });
check("v0.2 + matrix rejected", g.isError, g.text);
g = await call("generate_hyperexecute_yaml", { repoPath: fx("dotnet-nunit"), splitBy: "method" });
check("dotnet nunit v0.2", g.text.includes("name: dotnet/nunit") && g.text.includes("--project") && g.text.includes("Tests/Tests.csproj") && g.text.includes("idleTimeout: 900") && g.text.includes("version: \"8.0\""), g.text);
console.log(g.text, "\n");
v = JSON.parse((await call("validate_hyperexecute_yaml", { yamlContent: "version: \"0.2\"\nrunson: linux\nautosplit: true\nconcurrency: 2\ntestDiscovery:\n  type: raw\n  mode: remote\n  command: ls\nframework:\n  name: gradle/testng\n  discoveryMode: local\n  baseCommand: integrationTest\n" })).text);
check("v0.2 validator: testDiscovery trap, remote-only, baseCommand", v.errors.some((e) => e.includes("0 tests")) && v.errors.some((e) => e.includes("only supports remote")) && v.errors.some((e) => e.includes("baseCommand")), v);

// Security scan + credential fix (dry run)
let sc = JSON.parse((await call("scan_credentials_and_reporting", { repoPath: fx("creds") })).text);
check("credential scan finds LT creds, skips app login", sc.credentials.length === 13 && !JSON.stringify(sc).includes("standard_user") && !JSON.stringify(sc).includes("abcdefghijklmnop"), sc.summary);
check("reporting scan finds ReportPortal + Slack", ["reportportal", "slack"].every((k) => sc.reporting.some((r) => r.integration === k)), sc.reporting);
let fixr = await call("fix_hardcoded_credentials", { repoPath: fx("creds") });
check("credential fix dry run shows env lookups, writes nothing", fixr.text.startsWith("DRY RUN") && fixr.text.includes("System.getenv(\"LT_ACCESS_KEY\")") && fs.readFileSync(fx("creds") + "/src/test/java/com/acme/BaseTest.java", "utf8").includes("customerjohn"), fixr.text);

// Capabilities
let cap = await call("generate_lambdatest_capabilities", { repoPath: fx("creds"), browser: "Firefox", platform: "Windows 11" });
check("java connection point + in-place change", cap.text.includes("FirefoxOptions") && cap.text.includes("LT:Options") && /BaseTest\.java:21 \[remote/.test(cap.text) && /Change:/.test(cap.text) && /never|Do not create a new helper/i.test(cap.text), cap.text.slice(0, 900));
let opts = JSON.parse((await call("generate_lambdatest_capabilities", { repoPath: fx("creds"), listOptions: true })).text);
check("live capability options", opts.browsers.includes("Chrome") && opts.platforms.length > 3, opts);

// Optimizer
let op = JSON.parse((await call("optimize_hyperexecute_yaml", { repoPath: fx("maven-testng"), yamlContent: "version: 0.1\nrunson: mac\nautosplit: true\nconcurrency: 20\npre:\n  - mvn clean install\ntestDiscovery:\n  type: raw\n  mode: remote\n  command: ls\ntestRunnerCommand: mvn test -Dtest=$test\n" })).text);
check("optimizer suggestions", ["pre-skip-tests", "add-cache"].every((id) => op.suggestions.some((x) => x.id === id)), op);
let opa = await call("optimize_hyperexecute_yaml", { repoPath: fx("maven-testng"), yamlContent: "version: 0.1\nrunson: linux\nautosplit: true\nconcurrency: 2\npre:\n  - mvn clean install\ntestDiscovery:\n  type: raw\n  mode: remote\n  command: ls\ntestRunnerCommand: mvn test -Dtest=$test\n", apply: ["pre-skip-tests", "add-cache"] });
check("optimizer apply", opa.text.includes("-Dmaven.test.skip=true") && opa.text.includes("cacheKey"), opa.text);

// Run → watch → diagnose → fix → rerun (simulated CLI: fails on DNS until tunnel: true)
const loopRepo = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "he-loop-"));
fs.cpSync(fx("maven-testng"), loopRepo, { recursive: true });
await call("generate_hyperexecute_yaml", { repoPath: loopRepo, yamlVersion: "0.1", write: true, extraEnv: { BASE_URL: "https://example.com" } });
let run = JSON.parse((await call("run_hyperexecute_job", { repoPath: loopRepo })).text);
check("run started", run.status === "running" && run.runId, run);
let st = JSON.parse((await call("get_hyperexecute_run", { runId: run.runId, waitSeconds: 30 })).text);
check("run 1 diagnosed fixable (private network → tunnel)", st.status === "fixable" && st.diagnosis.diagnoses.some((d) => d.id === "private-network") && st.jobUrl, st);
let fr = JSON.parse((await call("fix_and_rerun_hyperexecute", { runId: run.runId })).text);
check("fix applied + rerun started", /tunnel/i.test(fr.applied.join()) && fr.nextRun?.attempt === 2 && /tunnel: true/.test(fs.readFileSync(loopRepo + "/hyperexecute.yaml", "utf8")), fr);
st = JSON.parse((await call("get_hyperexecute_run", { runId: fr.nextRun.runId, waitSeconds: 30 })).text);
check("run 2 passed", st.status === "passed", st);
let refuse = await call("fix_and_rerun_hyperexecute", { runId: fr.nextRun.runId });
check("no rerun after pass", refuse.isError && /passed/.test(refuse.text), refuse.text);
let dl = JSON.parse((await call("diagnose_hyperexecute_logs", { repoPath: fx("maven-testng"), logText: "Tests run: 5, Failures: 2\njava.lang.AssertionError: expected [x] but found [y]" })).text);
check("assertion failures → not a YAML problem", dl.diagnosis.status === "test-failures" && !dl.fixedYaml, dl);

// Per-test: fix only YAML-caused failures, rerun only those tests, leave code failures alone
{
  const repo2 = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "he-tests-"));
  fs.cpSync(fx("maven-testng"), repo2, { recursive: true });
  await call("generate_hyperexecute_yaml", { repoPath: repo2, yamlVersion: "0.1", write: true, extraEnv: { BASE_URL: "https://example.com" } });
  process.env.__keep = "";
  const t = await import("node:child_process");
  // point this server at the per-test fake CLI for the rest of the file
  await client.close();
  await client.connect(new StdioClientTransport({ command: "node", args: [path.join(here, "..", "src", "index.js")], env: { ...process.env, ATLASSIAN_API_TOKEN: "", LT_USERNAME: "tester", LT_ACCESS_KEY: "test-key-123", HE_CLI_PATH: path.join(here, "bin", "fake-hyperexecute-tests.cjs") } }));
  let r1 = JSON.parse((await call("run_hyperexecute_job", { repoPath: repo2 })).text);
  let s1 = JSON.parse((await call("get_hyperexecute_run", { runId: r1.runId, waitSeconds: 30 })).text);
  const tl = s1.diagnosis?.tests;
  check("per-test: 4 failed = 2 code + 2 yaml", tl && tl.failed === 4 && tl.code === 2 && tl.yaml === 2, s1);
  check("per-test: needs PAYMENT_API_URL value", s1.status === "fixable-tests" && s1.diagnosis.needsValue.includes("PAYMENT_API_URL"), s1.status);
  let f1 = JSON.parse((await call("fix_and_rerun_hyperexecute", { runId: r1.runId, values: { PAYMENT_API_URL: "https://pay.example.com" } })).text);
  check("targeted rerun of only the 2 YAML-affected tests", f1.rerunOnly?.length === 2 && f1.rerunOnly.every((x) => /invalidLogin|forgotPassword/.test(x)) && f1.leftAlone.length === 2, f1);
  check("main YAML fixed (tunnel + env value), rerun YAML separate", /tunnel: true/.test(fs.readFileSync(repo2 + "/hyperexecute.yaml", "utf8")) && /PAYMENT_API_URL: https:\/\/pay/.test(fs.readFileSync(repo2 + "/hyperexecute.yaml", "utf8")) && fs.existsSync(repo2 + "/.hyperexecute-rerun.yaml"), f1);
  let s2 = JSON.parse((await call("get_hyperexecute_run", { runId: f1.nextRun.runId, waitSeconds: 30 })).text);
  check("targeted rerun passed", s2.status === "passed" && s2.targetedRerun === true && s2.diagnosis.tests.total === 2, s2);
}

// Credentials saved once (isolated HOME so the real ~/.hyperexecute-studio is never touched)
{
  const os = await import("node:os");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "he-home-"));
  const repo3 = fs.mkdtempSync(path.join(os.tmpdir(), "he-creds-"));
  fs.cpSync(fx("maven-testng"), repo3, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, ATLASSIAN_API_TOKEN: "", HE_CLI_PATH: path.join(here, "bin", "fake-hyperexecute-tests.cjs") };
  delete env.LT_USERNAME; delete env.LT_ACCESS_KEY;
  await client.close();
  await client.connect(new StdioClientTransport({ command: "node", args: [path.join(here, "..", "src", "index.js")], env }));
  let st0 = JSON.parse((await call("lambdatest_credentials_status", {})).text);
  check("no account saved initially", st0.saved === false, st0);
  let bad = await call("set_lambdatest_credentials", { username: "nobody", accessKey: "not-a-real-key-12345678901234" });
  check("bad account rejected by LambdaTest and not saved", bad.isError && /401/.test(bad.text) && !fs.existsSync(path.join(home, ".hyperexecute-studio", "credentials.json")), bad.text);
  // simulate a verified save (no real key is available to the tests)
  fs.mkdirSync(path.join(home, ".hyperexecute-studio"), { recursive: true });
  fs.writeFileSync(path.join(home, ".hyperexecute-studio", "credentials.json"), JSON.stringify({ username: "roshan", accessKey: "LT_SavedKey1234567890abcdefXYZ" }), { mode: 0o600 });
  let st1 = JSON.parse((await call("lambdatest_credentials_status", {})).text);
  check("saved account picked up, key masked", st1.saved && st1.username === "roshan" && st1.accessKey === "LT_****", st1);
  const gy = (await call("generate_hyperexecute_yaml", { repoPath: repo3, yamlVersion: "0.1", write: true, extraEnv: { BASE_URL: "https://example.com" } })).text;
  const written = fs.readFileSync(path.join(repo3, "hyperexecute.yaml"), "utf8");
  check("saved account goes into the written YAML; the reply shows the key masked", /LT_USERNAME: roshan/.test(written) && written.includes("LT_ACCESS_KEY: LT_SavedKey1234567890abcdefXYZ") && gy.includes("LT_ACCESS_KEY: LT_****") && !gy.includes("LT_SavedKey1234567890abcdefXYZ"), gy.slice(0, 600));
  const sc3 = JSON.parse((await call("scan_credentials_and_reporting", { repoPath: repo3 })).text);
  check("own account in the HyperExecute YAML is not flagged as a hard-coded credential", !sc3.credentials.some((c) => c.file === "hyperexecute.yaml"), sc3.credentials);
  let r = JSON.parse((await call("run_hyperexecute_job", { repoPath: repo3 })).text);
  let s3 = JSON.parse((await call("get_hyperexecute_run", { runId: r.runId, waitSeconds: 30 })).text);
  const leftovers = fs.readdirSync(repo3).filter((n) => n.startsWith(".hyperexecute-run-"));
  const last = fs.readFileSync(path.join(repo3, ".fake-last-config"), "utf8");
  check("run used the saved account without asking", s3.status !== "running" && !/No LambdaTest account/.test(JSON.stringify(s3)), s3.status);
  check("CLI got the YAML with the account already in it (no temporary copy needed)", last === "hyperexecute.yaml filled", last);
  check("no temporary YAML left behind", leftovers.length === 0, leftovers);
  // with references (embedCredentials false) the run still fills them into a short-lived copy
  await call("generate_hyperexecute_yaml", { repoPath: repo3, yamlVersion: "0.1", write: true, outputFileName: "hyperexecute.yaml", embedCredentials: false, extraEnv: { BASE_URL: "https://example.com" } });
  const r4 = JSON.parse((await call("run_hyperexecute_job", { repoPath: repo3 })).text);
  await call("get_hyperexecute_run", { runId: r4.runId, waitSeconds: 30 });
  const last4 = fs.readFileSync(path.join(repo3, ".fake-last-config"), "utf8");
  check("secret references are filled into a temporary copy, then deleted", /^\.hyperexecute-run-.*\.yaml filled$/.test(last4) && !fs.readdirSync(repo3).some((n) => n.startsWith(".hyperexecute-run-")) && !fs.readFileSync(path.join(repo3, "hyperexecute.yaml"), "utf8").includes("LT_SavedKey"), last4);
  check("key never in output", !JSON.stringify(s3).includes("LT_SavedKey1234567890abcdefXYZ"));
}

// Knowledge base
let k = JSON.parse((await call("search_knowledge_base", { query: "cucumber report partialReports" })).text);
check("local KB search", k.local.length > 0 && k.confluence.configured === false, k);
k = JSON.parse((await call("search_knowledge_base", { query: "tests not found", source: "local" })).text);
check("KB synonyms: 'tests not found' → 'Discovery finds 0 tests'", k.local[0]?.section === "Discovery finds 0 tests", k.local.map((x) => x.section));
k = JSON.parse((await call("search_knowledge_base", { query: "playwright projects spread over VMs", source: "local" })).text);
check("golden YAMLs are searchable", k.local.slice(0, 2).some((x) => x.topic === "golden/playwright-projects-matrix"), k.local.map((x) => x.topic));

// ---------- harder layouts, confidence, questions ----------
a = JSON.parse((await call("analyze_repo", { repoPath: fx("gradle-kts") })).text);
check("gradle kts: junit5, java 21, modules", a.primaryFramework === "junit5" && a.runtimeVersion === "21" && a.gradleModules.join() === "api-tests,ui-tests", a);
g = await call("generate_hyperexecute_yaml", { repoPath: fx("gradle-kts"), yamlVersion: "0.1" });
d = JSON.parse((await call("dry_run_test_discovery", { repoPath: fx("gradle-kts"), command: extract(g) })).text);
check("gradle multi-module: each item is a module task", d.items.includes("api-tests:test --tests com.acme.api.UsersApiTest") && g.text.includes("./gradlew :$test"), d);
a = JSON.parse((await call("analyze_repo", { repoPath: fx("maven-profiles") })).text);
check("maven profiles → medium confidence + question", a.confidence.level === "medium" && a.questions.some((q) => /Maven profile/.test(q)) && Object.keys(a)[0] === "confidence", a.confidence);
g = await call("generate_hyperexecute_yaml", { repoPath: fx("maven-profiles"), mavenProfile: "smoke" });
check("mavenProfile → v0.2 flags -Psmoke", /flags:\n\s+- -Psmoke/.test(g.text) && g.text.includes("Confirm with the user"), g.text);
a = JSON.parse((await call("analyze_repo", { repoPath: fx("pyproject-only") })).text);
g = await call("generate_hyperexecute_yaml", { repoPath: fx("pyproject-only") });
check("pyproject-only: extras install, -n 0, testpaths", a.runtimeVersion === "3.11" && g.text.includes('pip3 install -e ".[test]"') && g.text.includes('"$test" -n 0') && g.text.includes("find tests "), g.text);
a = JSON.parse((await call("analyze_repo", { repoPath: fx("playwright-projects") })).text);
g = await call("generate_hyperexecute_yaml", { repoPath: fx("playwright-projects") });
check("playwright: script config, projects, script env", a.configFile === "e2e/pw.config.ts" && a.testDir === "e2e/specs" && a.playwrightProjects.length === 3 && g.text.includes("--config=e2e/pw.config.ts") && g.text.includes("TEST_ENV: staging"), g.text);
a = JSON.parse((await call("analyze_repo", { repoPath: fx("node-monorepo") })).text);
g = await call("generate_hyperexecute_yaml", { repoPath: fx("node-monorepo") });
check("workspace monorepo: finds cypress package, installs at root", a.primaryFramework === "cypress" && a.packageRoot === "packages/e2e" && /pre:\n\s+- npm ci/.test(g.text) && g.text.includes("cd packages/e2e && npx cypress run"), g.text);

// ---------- validator types + optional schema ----------
v = JSON.parse((await call("validate_hyperexecute_yaml", { yamlContent: "version: 0.1\nrunson: linux\nautosplit: true\nconcurrency: \"5\"\nretryOnFailure: yes please\ntestDiscovery:\n  type: raw\n  mode: remote\n  command: ls\ntestRunnerCommand: mvn test -Dtest=$test\npre: mvn install\n" })).text);
check("validator: value types", v.errors.some((e) => /concurrency.*should be int.*remove the quotes/.test(e)) && v.errors.some((e) => /retryOnFailure.*should be bool/.test(e)) && v.errors.some((e) => /`pre` should be list/.test(e)), v.errors);
{
  const { checkSchema } = await import("../src/validator.js");
  const errs = checkSchema({ runson: "ubuntu", concurrency: 0, extra: 1 }, { type: "object", required: ["version"], additionalProperties: false, properties: { runson: { enum: ["linux", "win"] }, concurrency: { type: "integer", minimum: 1 } } });
  check("schema subset checker", errs.length === 4, errs);
}

// ---------- feedback: unknown failures saved (masked), grouped, reviewable ----------
const weird = "Starting job\nconnecting to https://bob:LT_abcdefghijklmnopqrstuvwxyz123@hub.lambdatest.com/wd/hub\nFATAL: flux capacitor overheated at stage 3 (owner jane@acme.com)\nJob failed";
let dk = JSON.parse((await call("diagnose_hyperexecute_logs", { repoPath: fx("maven-testng"), logText: weird })).text);
dk = JSON.parse((await call("diagnose_hyperexecute_logs", { repoPath: fx("maven-testng"), logText: weird.replace("stage 3", "stage 7") })).text);
const saved = fs.readdirSync(path.join(process.env.HE_FEEDBACK_DIR, "unmatched"));
const savedText = saved.map((f) => fs.readFileSync(path.join(process.env.HE_FEEDBACK_DIR, "unmatched", f), "utf8")).join("\n");
check("unknown failure saved for review", dk.savedForReview && saved.length === 2, dk);
check("saved feedback is masked", !savedText.includes("LT_abcdefghijklmnopqrstuvwxyz123") && !savedText.includes("jane@acme.com") && !savedText.includes("bob:") && savedText.includes("flux capacitor"), savedText.slice(0, 800));
let rv = JSON.parse((await call("review_diagnosis_feedback", {})).text);
check("review groups the same failure (numbers ignored)", rv.unmatched.length === 1 && rv.unmatched[0].count === 2 && rv.unmatched[0].recurring, rv);
rv = JSON.parse((await call("review_diagnosis_feedback", { markReviewed: [rv.unmatched[0].signature] })).text);
check("markReviewed clears the group", rv.moved === 2 && rv.unmatched.length === 0, rv);
dk = JSON.parse((await call("diagnose_hyperexecute_logs", { repoPath: fx("maven-testng"), logText: "Tests run: 5, Failures: 2\njava.lang.AssertionError: expected [x] but found [y]" })).text);
check("recognized failures are not saved", !dk.savedForReview, dk);

// ---------- discovery check: a green run with 0 tests is not "passed" ----------
{
  const os = await import("node:os");
  const repo4 = fs.mkdtempSync(path.join(os.tmpdir(), "he-zero-"));
  fs.cpSync(fx("maven-testng"), repo4, { recursive: true });
  await client.close();
  await client.connect(new StdioClientTransport({ command: "node", args: [path.join(here, "..", "src", "index.js")], env: { ...process.env, HE_FAKE: "zero", ATLASSIAN_API_TOKEN: "", LT_USERNAME: "tester", LT_ACCESS_KEY: "test-key-123", HE_CLI_PATH: path.join(here, "bin", "fake-hyperexecute.sh") } }));
  await call("generate_hyperexecute_yaml", { repoPath: repo4, yamlVersion: "0.1", write: true, extraEnv: { BASE_URL: "https://example.com" } });
  const dr = JSON.parse((await call("dry_run_test_discovery", { repoPath: repo4 })).text);
  const r0 = JSON.parse((await call("run_hyperexecute_job", { repoPath: repo4 })).text);
  const s0 = JSON.parse((await call("get_hyperexecute_run", { runId: r0.runId, waitSeconds: 30 })).text);
  check("0-test green run is not reported as passed; discoveryCheck compares with the dry run", !/passed/.test(s0.status) && s0.discoveryCheck?.verdict === "zero-tests" && s0.discoveryCheck.expectedItems === dr.discovered, s0);
  const oc = fs.readFileSync(path.join(process.env.HE_FEEDBACK_DIR, "outcomes.jsonl"), "utf8");
  check("run outcome logged", oc.includes(r0.runId) && oc.includes('"discovery":"zero-tests"'), oc.slice(-400));
}
{
  const { checkDiscovery, platformDiscoveredCount } = await import("../src/discovery-check.js");
  check("CLI discovered-count parsing", platformDiscoveredCount("x\nDiscovered 12 tests\n") === 12 && platformDiscoveredCount("nothing") === null);
  const prof = { tests: { classes: [{ methods: [1, 2, 3, 4, 5, 6] }], functions: [], scenarios: [] }, language: "java", primaryFramework: "testng" };
  const c1 = checkDiscovery({ repo: "/nope", yamlText: "version: 0.1\nautosplit: true\n", profile: prof, output: "", tests: [{}, {}] });
  check("fewer tests ran than the repo has → flagged", c1.verdict === "fewer-than-expected", c1);
}

// ---------- CI pipelines, playbook, Ruby, mobile, learning ----------
{
  const os = await import("node:os");
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "he-learn-"));
  const repo5 = fs.mkdtempSync(path.join(os.tmpdir(), "he-learnrepo-"));
  fs.cpSync(fx("maven-testng"), repo5, { recursive: true });
  // a stand-in Confluence that records the page it's asked to create
  const http = await import("node:http");
  const created = [];
  const conf = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url.startsWith("/wiki/rest/api/user/current")) return res.end(JSON.stringify({ type: "known", displayName: "Tester" }));
      if (req.url.startsWith("/wiki/api/v2/spaces")) return res.end(JSON.stringify({ results: [{ id: "77", key: "HYP" }] }));
      if (req.url === "/wiki/api/v2/pages" && req.method === "POST") { const b = JSON.parse(body); created.push({ ...b, auth: req.headers.authorization }); return res.end(JSON.stringify({ id: "9001", title: b.title, _links: { base: "http://confluence.test/wiki", webui: "/spaces/HYP/pages/9001" } })); }
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise((r) => conf.listen(0, "127.0.0.1", r));
  const env = { ...process.env, HE_STATE_DIR: state, HE_KB_CACHE_DIR: path.join(state, "kb-cache"), HE_LEARN: "", HE_ACCURACY_CASES: "", ATLASSIAN_EMAIL: "qa@example.com", ATLASSIAN_API_TOKEN: "atl-token-xyz", CONFLUENCE_BASE_URL: `http://127.0.0.1:${conf.address().port}/wiki`, CONFLUENCE_SPACE: "HYP", LT_USERNAME: "tester", LT_ACCESS_KEY: "test-key-123", HE_CLI_PATH: path.join(here, "bin", "fake-hyperexecute.sh") };
  delete env.HE_ACCURACY_CASES;
  await client.close();
  await client.connect(new StdioClientTransport({ command: "node", args: [path.join(here, "..", "src", "index.js")], env }));
  check("server sends its playbook to the client", /analyze_repo first/.test(client.getInstructions() || ""), (client.getInstructions() || "").slice(0, 200));

  await call("generate_hyperexecute_yaml", { repoPath: repo5, yamlVersion: "0.1", write: true, outputFileName: "hyperexecute.yaml", tunnel: true, embedCredentials: false, extraEnv: { BASE_URL: "https://example.com" } });
  let ci = await call("generate_ci_pipeline", { repoPath: repo5, ci: "github", write: true });
  const wf = fs.existsSync(path.join(repo5, ".github/workflows/hyperexecute.yml")) ? fs.readFileSync(path.join(repo5, ".github/workflows/hyperexecute.yml"), "utf8") : "";
  check("CI pipeline: GitHub Actions file written, secrets from the CI, fill step", /secrets\.LT_ACCESS_KEY/.test(wf) && /sed -e/.test(wf) && /--config \.hyperexecute-ci\.yaml/.test(wf) && !/\$\{\{ *\.secrets/.test(wf.replace(/\$\{\{ secrets\.LT_(USERNAME|ACCESS_KEY) \}\}/g, "")), ci.text.slice(0, 400));
  ci = await call("generate_ci_pipeline", { repoPath: repo5, ci: "github", write: true });
  check("CI pipeline: refuses to overwrite", ci.isError && /already exists/.test(ci.text), ci.text);
  {
    const withKey = await call("generate_hyperexecute_yaml", { repoPath: repo5, write: true, outputFileName: "keyed.yaml" });
    const t = (await call("generate_ci_pipeline", { repoPath: repo5, ci: "gitlab", yamlPath: "keyed.yaml" })).text;
    check("CI pipeline: warns when the YAML holds a plain access key", /contains a LambdaTest access key in plain text/.test(t) && !withKey.isError, t.slice(-500));
  }
  for (const sys of ["gitlab", "jenkins", "azure"]) {
    const t = (await call("generate_ci_pipeline", { repoPath: repo5, ci: sys })).text;
    check(`CI pipeline: ${sys}`, /hyperexecute --user "\$LT_USERNAME" --key "\$LT_ACCESS_KEY"/.test(t), t.slice(0, 300));
  }

  // Ruby + mobile capabilities
  let rb = await call("generate_hyperexecute_yaml", { repoPath: fx("ruby-rspec"), splitBy: "method" });
  check("Ruby RSpec: bundle install + rspec per example", /bundle install/.test(rb.text) && /bundle exec rspec "\$test"/.test(rb.text) && /language: ruby/.test(rb.text) && /version: 3\.2\.2|version: "3\.2\.2"/.test(rb.text), rb.text.slice(0, 800));
  let d5 = JSON.parse((await call("dry_run_test_discovery", { repoPath: fx("ruby-rspec"), command: extract(rb) })).text);
  check("Ruby RSpec: discovery finds file:line examples", d5.discovered === 2 && /spec\/cart_spec\.rb:\d+/.test(d5.items[0]), d5);
  let capRb = await call("generate_lambdatest_capabilities", { repoPath: fx("ruby-rspec"), browser: "Firefox" });
  check("Ruby: local driver found, replaced in place on the same variable", /spec\/spec_helper\.rb:5 \[local\]/.test(capRb.text) && /Selenium::WebDriver::Options\.firefox/.test(capRb.text) && /@driver = Selenium::WebDriver\.for\(:remote/.test(capRb.text) && !/lambdatest_driver\.rb/.test(capRb.text), capRb.text.slice(0, 900));
  check("connection tool creates no files", !fs.existsSync(path.join(fx("ruby-rspec"), "spec", "lambdatest_driver.rb")) && fs.readdirSync(path.join(fx("ruby-rspec"), "spec")).length === 2);
  let capMob = await call("generate_lambdatest_capabilities", { repoPath: fx("pytest"), mobile: true, device: "Pixel 8" });
  check("Appium real-device capabilities", /mobile-hub\.lambdatest\.com/.test(capMob.text) && /Pixel 8/.test(capMob.text) && /isRealMobile/.test(capMob.text) && /lt:\/\/APP_ID/.test(capMob.text), capMob.text.slice(0, 300));

  // learning: the same choice twice becomes the starting point; explicit options still win
  await call("generate_hyperexecute_yaml", { repoPath: repo5, runson: "win11", concurrency: 12, write: true, outputFileName: "a.yaml" });
  await call("generate_hyperexecute_yaml", { repoPath: repo5, runson: "win11", concurrency: 12, write: true, outputFileName: "b.yaml" });
  let lg = await call("generate_hyperexecute_yaml", { repoPath: repo5 });
  check("learning: usual settings applied and announced", /runson: win11/.test(lg.text) && /concurrency: 12/.test(lg.text) && /usual settings/.test(lg.text), lg.text.slice(0, 700));
  lg = await call("generate_hyperexecute_yaml", { repoPath: repo5, runson: "linux" });
  check("learning: explicit option wins", /runson: linux/.test(lg.text) && /concurrency: 12/.test(lg.text), lg.text.slice(0, 500));
  lg = await call("generate_hyperexecute_yaml", { repoPath: repo5, useLearned: false });
  check("learning: useLearned:false ignores it", /runson: linux/.test(lg.text) && /concurrency: 5/.test(lg.text));

  // a passing run is saved as an accuracy case, with credentials as references only
  const r6 = JSON.parse((await call("run_hyperexecute_job", { repoPath: repo5 })).text);
  const s6 = JSON.parse((await call("get_hyperexecute_run", { runId: r6.runId, waitSeconds: 30 })).text);
  const caseDir = path.join(state, "accuracy-cases", path.basename(repo5));
  const saved = fs.existsSync(path.join(caseDir, "expected.yaml")) ? fs.readFileSync(path.join(caseDir, "expected.yaml"), "utf8") : "";
  check("passing run saved as an accuracy case", s6.status === "passed" && /saved as an accuracy case/.test(s6.savedAsAccuracyCase || "") && /tunnel: true/.test(saved) && !/test-key-123/.test(saved), JSON.stringify(s6).slice(0, 400));
  const teamFile = path.join(repo5, ".hyperexecute", "team.json");
  const tm0 = fs.existsSync(teamFile) ? JSON.parse(fs.readFileSync(teamFile, "utf8")) : {};
  check("team memory: passing run recorded in the repo", tm0.passingSetups?.length === 1 && tm0.options?.tunnel === true && /Team memory updated/.test(s6.teamMemory || "") && !JSON.stringify(tm0).includes("test-key-123"), JSON.stringify(tm0).slice(0, 400));

  // team memory: an explicit decision is shared, beats this user's usual settings, loses to explicit options
  let tm = JSON.parse((await call("remember_for_team", { repoPath: repo5, options: { runson: "mac", concurrency: 20, extraEnv: { BASE_URL: "https://staging.example.com", API_TOKEN: "abc" } }, note: "Staging needs the tunnel" })).text);
  check("team memory: saved, secret env refused", tm.options.runson === "mac" && tm.options.extraEnv.BASE_URL && !tm.options.extraEnv.API_TOKEN && tm.rejected?.some((r) => /API_TOKEN/.test(r)) && tm.notes.includes("Staging needs the tunnel"), tm);
  lg = await call("generate_hyperexecute_yaml", { repoPath: repo5 });
  check("team memory: team settings win over usual settings", /runson: mac/.test(lg.text) && /concurrency: 20/.test(lg.text) && /staging\.example\.com/.test(lg.text) && /team's settings/.test(lg.text), lg.text.slice(0, 900));
  lg = await call("generate_hyperexecute_yaml", { repoPath: repo5, runson: "linux" });
  check("team memory: explicit option wins", /runson: linux/.test(lg.text) && /concurrency: 20/.test(lg.text), lg.text.slice(0, 500));
  const an = JSON.parse((await call("analyze_repo", { repoPath: repo5 })).text);
  check("team memory: analyze_repo shows notes", an.teamMemory?.notes?.includes("Staging needs the tunnel") && an.teamMemory.lastPassing, an.teamMemory);
  tm = JSON.parse((await call("remember_for_team", { repoPath: repo5, unset: ["runson"], removeNote: "staging" })).text);
  check("team memory: unset and remove note", !tm.options.runson && !tm.notes.length, tm);
  await call("remember_for_team", { repoPath: repo5, options: { splitBy: "nonsense-split" } });
  lg = await call("generate_hyperexecute_yaml", { repoPath: repo5 });
  check("team memory: a setting that doesn't fit is dropped, not an error", !lg.isError && /runson:/.test(lg.text), lg.text.slice(0, 300));

  // learning from fixes that worked: fail (DNS) → fix (tunnel) → pass, then the same failure elsewhere gets the fix suggested
  const repo6 = fs.mkdtempSync(path.join(os.tmpdir(), "he-fixlearn-"));
  fs.cpSync(fx("maven-testng"), repo6, { recursive: true });
  await call("generate_hyperexecute_yaml", { repoPath: repo6, yamlVersion: "0.1", write: true, embedCredentials: false, useLearned: false, extraEnv: { BASE_URL: "https://example.com" } });
  const f1 = JSON.parse((await call("run_hyperexecute_job", { repoPath: repo6 })).text);
  const f1d = JSON.parse((await call("get_hyperexecute_run", { runId: f1.runId, waitSeconds: 30 })).text);
  const f2 = JSON.parse((await call("fix_and_rerun_hyperexecute", { runId: f1.runId })).text);
  const f2d = JSON.parse((await call("get_hyperexecute_run", { runId: f2.nextRun.runId, waitSeconds: 30 })).text);
  const learnedFile = path.join(state, "learned-fixes.json");
  const lf = fs.existsSync(learnedFile) ? JSON.parse(fs.readFileSync(learnedFile, "utf8")) : [];
  const team6 = JSON.parse(fs.readFileSync(path.join(repo6, ".hyperexecute", "team.json"), "utf8"));
  check("learning: a fix that made the next run pass is remembered", f1d.status !== "passed" && f2d.status === "passed" && /remembered/.test(f2d.learned || "") && lf[0]?.change?.added.some((l) => /tunnel: true/.test(l)) && team6.fixesThatWorked?.[0]?.worked === 1, JSON.stringify({ s1: f1d.status, s2: f2d.status, learned: f2d.learned, lf: lf[0] }).slice(0, 600));
  const repo7 = fs.mkdtempSync(path.join(os.tmpdir(), "he-fixlearn2-"));
  fs.cpSync(fx("maven-testng"), repo7, { recursive: true });
  await call("generate_hyperexecute_yaml", { repoPath: repo7, yamlVersion: "0.1", write: true, embedCredentials: false, useLearned: false, extraEnv: { BASE_URL: "https://example.com" } });
  const g1 = JSON.parse((await call("run_hyperexecute_job", { repoPath: repo7 })).text);
  const g1d = JSON.parse((await call("get_hyperexecute_run", { runId: g1.runId, waitSeconds: 30 })).text);
  check("learning: the same failure later shows the fix that worked", g1d.fixedBefore?.change?.added?.some((l) => /tunnel: true/.test(l)) && g1d.fixedBefore.from === "this machine", JSON.stringify(g1d.fixedBefore || g1d).slice(0, 400));

  // the session as a document: preview, then a Confluence page (stand-in server)
  let doc = (await call("publish_to_confluence", { repoPath: repo6, preview: true })).text;
  check("Confluence preview: what was done, runs, learned fix, YAML, no secrets", /## What was done/.test(doc) && /Fixed the YAML/.test(doc) && /## Runs/.test(doc) && /## Learned from this session/.test(doc) && /```yaml/.test(doc) && !/test-key-123/.test(doc) && /Not published/.test(doc) && !created.length, doc.slice(0, 900));
  const pub = await call("publish_to_confluence", { repoPath: repo6 });
  const page = created[0];
  check("Confluence page created in the space, storage format, no secrets", !pub.isError && page?.spaceId === "77" && /HyperExecute setup: he-fixlearn-/.test(page.title) && /ac:name="status"/.test(page.body.value) && /ac:name="code"/.test(page.body.value) && /<h2>Problems and how they were fixed<\/h2>/.test(page.body.value) && !/test-key-123|tester/.test(page.body.value) && /^Basic /.test(page.auth) && /confluence\.test\/wiki\/spaces\/HYP\/pages\/9001/.test(pub.text), (pub.text + JSON.stringify(page || {})).slice(0, 700));
  const kbHit = JSON.parse((await call("search_knowledge_base", { query: "he-fixlearn tunnel learned" })).text || "[]");
  check("the published page becomes searchable knowledge", JSON.stringify(kbHit).includes("he-fixlearn"), JSON.stringify(kbHit).slice(0, 300));
  conf.close();
}

// Pre step failures: read the stage log (logs/<job>/tasks/<task>/pre, no extension) and fix the YAML from it
{
  const preRepo = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "he-pre-"));
  fs.cpSync(fx("playwright"), preRepo, { recursive: true });
  await call("generate_hyperexecute_yaml", { repoPath: preRepo, yamlVersion: "0.1", write: true });
  const task = path.join(preRepo, "he-logs", "logs", "job-1", "tasks", "TASK-1");
  fs.mkdirSync(task, { recursive: true });
  fs.mkdirSync(path.join(preRepo, "he-logs", ".hyperexecute"));
  fs.writeFileSync(path.join(preRepo, "he-logs", ".hyperexecute", "result.json"), JSON.stringify({ id: "job-1", remark: "step 1 - exit status 1", tasks: [{ id: "TASK-1", status: "failed", remark: "step 1 - exit status 1", stages: [{ type: "prerun", status: "failed", name: "pre" }] }] }));
  // the CLI debug log's transfer chatter must not read as failed tests
  fs.writeFileSync(path.join(preRepo, "he-logs", "hyperexecute-cli.log"), [{ level: "debug", time: "2026-01-01T00:00:00.000+0530", msg: "Azcopy output: 100.0 %, 1 Done, 0 Failed, 0 Pending, 3 failed, 1 Total" }, { level: "info", time: "2026-01-01T00:00:01.000+0530", msg: "x [1]  pre (2s)\n" }].map((l) => JSON.stringify(l)).join("\n"));
  fs.writeFileSync(path.join(task, "pre"), "******************* npm ci *******************\nnpm ERR! code ERESOLVE\nnpm ERR! ERESOLVE could not resolve\nnpm ERR! this command with --force, or --legacy-peer-deps\n");
  let pf = JSON.parse((await call("diagnose_hyperexecute_logs", { repoPath: preRepo, logPath: "he-logs" })).text);
  check("pre failure (npm ERESOLVE) → fixable from the pre log", pf.diagnosis.status === "fixable" && pf.diagnosis.failedStage?.command === "npm ci" && pf.diagnosis.diagnoses[0].id === "npm-peer-deps" && /- npm ci --legacy-peer-deps/.test(pf.fixedYaml), pf);
  fs.writeFileSync(path.join(task, "pre"), "******************* npm ci *******************\nadded 120 packages\n******************* ./scripts/seed.sh *******************\nseed: 3 failed, database refused connection\n");
  pf = JSON.parse((await call("diagnose_hyperexecute_logs", { repoPath: preRepo, logPath: "he-logs" })).text);
  check("unrecognized pre failure → YAML problem with the failing command's log, never test-failures", pf.diagnosis.status === "needs-attention" && pf.diagnosis.diagnoses[0].id === "pre-step-failed" && pf.diagnosis.failedStage.command === "./scripts/seed.sh" && /^----- failed pre step: \.\/scripts\/seed\.sh/.test(pf.logDigest) && !pf.diagnosis.diagnoses.some((x) => x.notYaml), pf);
  pf = JSON.parse((await call("diagnose_hyperexecute_logs", { repoPath: preRepo, logText: "x [1]  pre (2s)\ntaskId:TASK-1 has failed with remark: step 1 - exit status 1\n    Failed pre stage percentage:          100.00%\n2 failed, 1 passed" })).text);
  check("pre failure seen only in CLI output → not test-failures", pf.diagnosis.status === "needs-attention" && pf.diagnosis.failedStage?.stage === "pre" && pf.diagnosis.failedStage.step === 1, pf);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
await client.close();
process.exit(failures ? 1 : 0);

function extract(res) {
  const block = res.text.match(/```yaml\n([\s\S]*?)\n```/);
  const cmd = block && YAML.parse(block[1])?.testDiscovery?.command;
  if (!cmd) throw new Error("no discovery command in:\n" + res.text);
  return cmd;
}
