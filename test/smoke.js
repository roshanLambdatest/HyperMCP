// End-to-end smoke test: spawns the MCP server over stdio and exercises every tool against the fixtures.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import YAML from "yaml";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
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
check("tools registered", ["analyze_repo", "generate_hyperexecute_yaml", "validate_hyperexecute_yaml", "dry_run_test_discovery", "search_knowledge_base", "get_confluence_page", "knowledge_base_status", "scan_credentials_and_reporting", "fix_hardcoded_credentials", "generate_lambdatest_capabilities", "optimize_hyperexecute_yaml", "run_hyperexecute_job", "get_hyperexecute_run", "fix_and_rerun_hyperexecute", "diagnose_hyperexecute_logs"].every((t) => tools.includes(t)), tools);

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
check("pytest yaml", g.text.includes("python3 -m pytest") && g.text.includes("secrets.LT_ACCESS_KEY"), g.text);
d = JSON.parse((await call("dry_run_test_discovery", { repoPath: fx("pytest"), command: extract(g, "command") })).text);
check("pytest method discovery", d.discovered === 2 && d.items.includes("tests/test_login.py::TestCheckout::test_pay"), d);

// Validator
var v = JSON.parse((await call("validate_hyperexecute_yaml", { yamlContent: "version: 0.1\nrunson: ubuntu\nautosplit: true\nconcurency: 2\ntestDiscovery:\n  type: raw\n  mode: remote\n  command: ls\ntestRunnerCommand: mvn test\nenv:\n  LT_ACCESS_KEY: abc123\nuploadArtifacts: []\n" })).text);
check("validator catches bad runson / missing $test / typo / secret / spelling",
  v.errors.some((e) => e.includes("runson")) && v.errors.some((e) => e.includes("$test")) && v.warnings.some((w) => w.includes('"concurrency"')) && v.warnings.some((w) => w.includes("secret")) && v.errors.some((e) => e.includes("uploadArtefacts")), v);


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
check("java capabilities helper", cap.text.includes("FirefoxOptions") && cap.text.includes("LT:Options") && cap.text.includes("BaseTest.java:21"), cap.text.slice(0, 600));
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

// Knowledge base
let k = JSON.parse((await call("search_knowledge_base", { query: "cucumber report partialReports" })).text);
check("local KB search", k.local.length > 0 && k.confluence.configured === false, k);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
await client.close();
process.exit(failures ? 1 : 0);

function extract(res) {
  const block = res.text.match(/```yaml\n([\s\S]*?)\n```/);
  const cmd = block && YAML.parse(block[1])?.testDiscovery?.command;
  if (!cmd) throw new Error("no discovery command in:\n" + res.text);
  return cmd;
}
