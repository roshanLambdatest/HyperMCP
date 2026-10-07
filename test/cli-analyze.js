// hyperexecute analyze: the parser on real outputs (test/cli-analyze/*.txt, captured from CLI 0.2.358),
// running it (account in the environment, log file cleaned up), what it changes before generating,
// and the MCP rule: no YAML without a LambdaTest account.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseCliAnalyze, runCliAnalyze, applyCliAnalyze } from "../src/cli-analyze.js";
import { analyzeRepo } from "../src/analyzer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, "bin", "fake-hyperexecute.sh");
let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (detail !== undefined) console.log(String(detail).slice(0, 800)); }
};
const out = (name) => parseCliAnalyze(fs.readFileSync(path.join(here, "cli-analyze", `${name}.txt`), "utf8"));

// ---------- parsing real outputs ----------
let a = out("maven-cucumber");
check("Maven + Cucumber: language, build tool, framework versions", a.supported && a.language === "Java" && a.buildTool === "maven" && a.buildToolVersion === "3.9.9" && a.frameworks.map((f) => `${f.name} ${f.version}`).join(", ") === "testng 7.10.2, cucumber 7.18.0", JSON.stringify(a));
check("Maven + Cucumber: nothing private", !a.privateRegistries.length && !a.privateEndpoints.length && !a.inaccessibleUrls.length);
a = out("maven-testng");
check("Maven + TestNG: the project's declared Java version, apart from this machine's", a.declaredRuntime === "17" && a.machineRuntime === "17" && a.modules[0]?.id === "com.acme:demo:1.0", JSON.stringify(a));
a = out("playwright-projects");
check("TypeScript: npm, and the public npm registry isn't 'private'", a.supported && a.language === "TypeScript" && a.packageManager === "npm" && !a.privateRegistries.length, JSON.stringify(a));
a = out("pyproject-only");
check("Python: unsupported, with the reason", !a.supported && /doesn't support Python/.test(a.reason), JSON.stringify(a));
a = out("ruby-rspec");
check("Ruby: no language detected", !a.supported && /couldn't detect/.test(a.reason), a.reason);
a = out("dotnet-nunit");
check(".NET without the SDK: says dotnet is missing", !a.supported && /dotnet isn't installed/.test(a.reason), a.reason);

// ---------- what it changes before generating ----------
const profile = analyzeRepo(path.join(here, "fixtures", "maven-cucumber"));
let r = applyCliAnalyze(profile, out("maven-cucumber"));
check("this machine's Java never becomes the YAML's runtime", r.profile.runtimeVersion === profile.runtimeVersion && /cucumber-java:7\.18\.0/.test(r.notes.join(" ")), JSON.stringify({ before: profile.runtimeVersion, after: r.profile.runtimeVersion, notes: r.notes }));
r = applyCliAnalyze({ ...profile, runtimeVersion: undefined }, { ...out("maven-testng") });
check("the project's declared Java version is used when the Studio found none", r.profile.runtimeVersion === "17", JSON.stringify(r));
r = applyCliAnalyze(profile, { ...out("maven-cucumber"), privateEndpoints: ["staging.acme.internal"], inaccessibleUrls: ["http://10.0.4.12:8080"] });
check("private or unreachable URLs turn the tunnel on by default", r.defaults.tunnel === true && /Tunnel on/.test(r.notes.join(" ")), JSON.stringify(r.defaults));
r = applyCliAnalyze(profile, out("pyproject-only"));
check("unsupported language: the Studio's own analysis, said plainly", !Object.keys(r.defaults).length && /Studio's own analysis/.test(r.notes[0]), r.notes[0]);

// ---------- running it ----------
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "he-analyze-"));
const calls = path.join(repo, "..", `${path.basename(repo)}-calls.log`);
process.env.FAKE_ANALYZE_LOG = calls;
const run = await runCliAnalyze({ cli: fake, repoPath: repo, username: "tester", accessKey: "secret-key-1" });
check("runs with the account in the environment, removes the log file it writes", run.supported && fs.readFileSync(calls, "utf8").includes("user=tester") && !fs.existsSync(path.join(repo, "hyperexecute-analyze.log")));
fs.writeFileSync(path.join(repo, "hyperexecute-analyze.log"), "the repo's own");
await runCliAnalyze({ cli: fake, repoPath: repo, username: "tester", accessKey: "secret-key-1" });
check("keeps a log file the repo already had", fs.existsSync(path.join(repo, "hyperexecute-analyze.log")));
check("refuses without an account", await runCliAnalyze({ cli: fake, repoPath: repo, username: "", accessKey: "" }).then(() => false, (e) => /username and access key/.test(e.message)));

// ---------- MCP: no YAML without an account; with one, analyze runs first ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), "he-home-")); // no saved credentials here
const mcp = async (env) => {
  const client = new Client({ name: "cli-analyze-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [path.join(here, "..", "src", "index.js")], env: { ...process.env, HOME: home, USERPROFILE: home, HE_STATE_DIR: path.join(home, "state"), HE_UPDATE_CHECK: "off", HE_GISTS: "off", HE_DOCS: "off", HE_CLI_PATH: fake, FAKE_ANALYZE_LOG: calls, ...env } }));
  return client;
};
const repoCopy = fs.mkdtempSync(path.join(os.tmpdir(), "he-mcp-repo-"));
fs.cpSync(path.join(here, "fixtures", "maven-cucumber"), repoCopy, { recursive: true });
let client = await mcp({ LT_USERNAME: "", LT_ACCESS_KEY: "" });
let res = await client.callTool({ name: "generate_hyperexecute_yaml", arguments: { repoPath: repoCopy } });
check("MCP: no YAML without a LambdaTest account", res.isError && /needs the user's LambdaTest account/.test(res.content[0].text), res.content[0].text);
await client.close();
client = await mcp({ LT_USERNAME: "tester", LT_ACCESS_KEY: "test-key-123" });
fs.writeFileSync(calls, "");
res = await client.callTool({ name: "generate_hyperexecute_yaml", arguments: { repoPath: repoCopy, embedCredentials: false } });
check("MCP: with an account, analyze runs first and its findings are in the notes", !res.isError && /HyperExecute analyze: .*cucumber-java:7\.18\.0/.test(res.content[0].text) && /user=tester/.test(fs.readFileSync(calls, "utf8")), res.content[0].text.slice(0, 600));
await client.close();

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
