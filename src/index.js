#!/usr/bin/env node
// HyperExecute YAML MCP server (stdio).

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import YAML from "yaml";
import { analyzeRepo, summarizeProfile } from "./analyzer.js";
import { generateYaml, v02FrameworkName, embeddedCredentials } from "./generator.js";
import { ensureCli, startRun } from "./runner.js";
import { loadCreds, saveCreds, verifyCreds, CREDS_FILE } from "./credentials.js";
import { collectEvidence, diagnose, applyDiagnosisFixes, logDigest, describeDiagnosis, buildTargetedRerun, fixableSelectors } from "./doctor.js";
import { validateYaml } from "./validator.js";
import { searchKnowledge, listTopics, getTopic, KB_DIRS, cacheConfluencePage, cacheStatus } from "./knowledge.js";
import { confluenceConfig, searchConfluence, getConfluencePage, whoAmI, createConfluencePage } from "./confluence.js";
import { scanRepo, scanCredentials, planCredentialFixes, applyCredentialFixes } from "./security.js";
import { capabilityOptions, generateConnection, findDriverSetup, planConnectionChanges } from "./capabilities.js";
import { optimizeYaml, applyOptimizations, describeSuggestions } from "./optimizer.js";
import { recordUnmatched, recordOutcome, reviewFeedback, markReviewed, feedbackDir, headline, mask } from "./feedback.js";
import { saveDryRun, checkDiscovery } from "./discovery-check.js";
import { generatePipeline, CI_SYSTEMS } from "./pipelines.js";
import { investigate, changeKey } from "./investigate.js";
import { withLearned, recordChoice, saveSuccessCase, readTeamMemory, rememberForTeam, recordTeamPass, recordFixThatWorked, findLearnedFix, yamlChange, applyTeamFixes, promotionCandidates, promoteTeamFix, markStoppedTeamFixes, personalFixSuggestions, TEAM_FILE, TEAM_OPTIONS } from "./learning.js";
import { startUpdateCheck, updateInfo, takeUpdateNote } from "./updates.js";
import { buildSetupReport } from "./report.js";
import { syncGists, gistsStatus, gistSources } from "./gists.js";
import { searchDocs, docsStatus, localIsWeak } from "./docs.js";
import { runCliAnalyze, applyCliAnalyze } from "./cli-analyze.js";

// Sent to every MCP client (Claude, Copilot…) on connect: the playbook, so the agent follows it without being told.
const INSTRUCTIONS = `HyperExecute Studio: tools that turn a test-automation repo into a checked, running HyperExecute setup. The tools apply fixed, tested rules; you decide the order, ask the user what only they know, and explain.

Workflow for "set up HyperExecute" (or anything like it):
1. analyze_repo first. If confidence is not "high", show the assumptions and ASK its questions before generating; never guess a Maven profile, env values or which framework runs. If it returns teamMemory, follow its notes: the team already decided those things.
2. If analyze_repo lists existingHyperExecuteYamls, offer to validate_hyperexecute_yaml + optimize_hyperexecute_yaml that file before generating a new one.
3. scan_credentials_and_reporting before any run; offer fix_hardcoded_credentials when it finds the customer's keys in code.
4. generate_hyperexecute_yaml needs the user's LambdaTest account (set_lambdatest_credentials, or the Studio's Setup card): it runs HyperExecute's own analyzer (hyperexecute analyze) on the repo first and refuses without an account. Call it with only the options the user asked for (it starts from the team's settings for the repo, then the user's learned usual settings), then validate_hyperexecute_yaml. For v0.1, dry_run_test_discovery and compare the count with the tests analyze_repo found.
5. Write the file (write: true) only after the user agrees. Offer generate_ci_pipeline when they want runs from CI.
6. run_hyperexecute_job, then get_hyperexecute_run until done. Follow its "next". On fixable failures use fix_and_rerun_hyperexecute (max 3 attempts). Never rerun for test-failures (code bugs) or auth errors: report them.
7. A green run with discoveryCheck "zero-tests" is a failure: fix discovery before calling it done.
8. When the user wants the work documented or shared ("add to Confluence"), publish_to_confluence (preview: true first if they want to see it).

Rules that matter:
- YAML v0.2 (framework:) exists only for Maven/Gradle TestNG, JUnit 4/5, Spock and .NET NUnit/MSTest, and must never contain testDiscovery (the job would run 0 tests). Tags, files, features, scenarios, matrix mode and custom commands need v0.1.
- runson is linux, mac, mac13, win or win11. Cross-browser or multi-OS = matrix axes in v0.1.
- Values the tests read (BASE_URL…) come from the user: ask, never invent. Secrets stay \${{ .secrets.X }} unless the user saved their own LambdaTest account.
- When no rule explains a failure, read the logDigest, propose a minimal YAML change, validate it, then fix_and_rerun_hyperexecute with yamlContent. Unrecognized failures are saved for review_diagnosis_feedback.
- Learning from what worked: when a fix makes the next run pass, the failure and the YAML change are remembered automatically (this machine + the repo's team memory). When get_hyperexecute_run or diagnose_hyperexecute_logs returns fixedBefore, try that change first if it fits the YAML.
- When the user states a lasting decision for this repo ("always win11", "use the ci profile", "staging needs the tunnel") or corrects the YAML in a way that should stick, call remember_for_team so every teammate's agent gets it.
- Grid connection: generate_lambdatest_capabilities finds where the repo connects. Tell the user those file:line locations; change the existing code in place only when asked. Never create a new helper or connection file.
- When search_knowledge_base returns docs results (public TestMu AI docs, the fallback when the knowledge base has no good answer), answer from them and cite the page URL.
- Knowledge results with source "gist" are field examples from real customer setups (HE_GISTS): reuse their patterns (discovery scripts, pre steps, runTest.sh), but check against the docs and this repo, and never copy another customer's names, URLs or values.
- search_knowledge_base for special requirements (tunnel, reports, secrets, mobile, a framework you are unsure about) before generating.`;

const server = new McpServer({ name: "hyperexecute", version: "1.11.0" }, { instructions: INSTRUCTIONS });

// the first reply after a newer release is known carries a one-line note (a separate block, so JSON replies stay JSON)
const text = (obj) => {
  const note = takeUpdateNote();
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }, ...(note ? [{ type: "text", text: note }] : [])] };
};
// hyperexecute analyze, once per repo per session: required before any YAML is generated.
const cliAnalyses = new Map();
async function hyperexecuteAnalyze(repo, { refresh = false } = {}) {
  const creds = loadCreds();
  if (!creds) throw new Error("HyperExecute analyze runs before any YAML is generated, and it needs the user's LambdaTest account. Ask the user to add it in the Studio's Setup card (or set_lambdatest_credentials), then generate again.");
  if (!refresh && cliAnalyses.has(repo)) return cliAnalyses.get(repo);
  const a = await runCliAnalyze({ cli: await ensureCli(repo), repoPath: repo, username: creds.username, accessKey: creds.accessKey });
  cliAnalyses.set(repo, a);
  logStep(repo, "Ran HyperExecute analyze", a.supported ? `${a.language}${a.frameworks.length ? " · " + a.frameworks.map((f) => f.coordinate || f.name).join(", ") : ""}` : a.reason);
  return a;
}
// what the agent needs from it (the raw output stays out of the chat)
const analyzeSummary = (a) => a && { supported: a.supported, reason: a.reason || undefined, language: a.language, declaredRuntime: a.declaredRuntime, buildTool: a.buildTool, packageManager: a.packageManager, frameworks: a.frameworks, privateRegistries: a.privateRegistries, privateEndpoints: a.privateEndpoints, inaccessibleUrls: a.inaccessibleUrls };

const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message || e}` }] });

// Default repo = HE_DEFAULT_REPO or the first workspace root the client opened the server in.
const resolveRepo = (p) => path.resolve(p || process.env.HE_DEFAULT_REPO || process.cwd());

// What was done per repo in this session, for the Confluence record (publish_to_confluence).
const activity = new Map();
function logStep(repo, step, detail) {
  const list = activity.get(repo) || [];
  list.push({ at: Date.now(), step, detail: detail ? String(detail).slice(0, 300) : undefined });
  activity.set(repo, list.slice(-100));
}

// ---------- tools ----------

server.registerTool(
  "analyze_repo",
  {
    title: "Analyze automation repo",
    description:
      "Scan a test-automation repo: language, build tool, framework (TestNG, JUnit, Cucumber, Playwright, Cypress, WebdriverIO, pytest, Behave, Robot, NUnit, SpecFlow…), test classes/files/features, tags, env vars the code reads, grid usage, Maven profiles, Gradle modules, workspace packages, npm test scripts, existing HyperExecute YAMLs. Returns confidence (high/medium/low), assumptions and questions first. USE FIRST on any repo. If confidence is not high, show the assumptions and ASK the questions before generating — don't guess. Not for YAML linting (validate_hyperexecute_yaml).",
    inputSchema: { repoPath: z.string().optional().describe("Absolute path to the repo (defaults to the workspace folder)") },
  },
  async ({ repoPath }) => {
    try {
      const repo = resolveRepo(repoPath);
      const summary = summarizeProfile(analyzeRepo(repo));
      logStep(repo, "Analyzed the repo", `${summary.primaryFramework || "no framework"} · confidence ${summary.confidence?.level}`);
      try {
        summary.hyperexecuteAnalyze = analyzeSummary(await hyperexecuteAnalyze(repo, { refresh: true }));
      } catch (e) {
        summary.hyperexecuteAnalyze = { error: e.message };
      }
      const team = readTeamMemory(repo);
      if (team) summary.teamMemory = { file: TEAM_FILE, options: team.options, notes: team.notes, lastPassing: team.passingSetups[0] };
      return text(summary);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "generate_hyperexecute_yaml",
  {
    title: "Generate HyperExecute YAML",
    description:
      "Build a HyperExecute YAML from the detected stack. USE after analyze_repo, once its questions are answered. Defaults are good: autosplit by class/file/feature, v0.2 native runner for Maven/Gradle TestNG/JUnit/Spock and .NET NUnit/MSTest. Only pass options the user asked for or analyze_repo's questions resolved, e.g. {splitBy:\"tag\"} for tags, {mavenProfile:\"smoke\"}, {extraMatrix:{project:[\"chromium\",\"firefox\"]}} for Playwright projects, {runsonMatrix:[\"linux\",\"win\"], executionMode:\"matrix\"} for multi-OS. Returns the YAML, notes, warnings and validation; write:true saves it. DON'T use to fix a failed run (use fix_and_rerun_hyperexecute) or to tune an existing YAML (optimize_hyperexecute_yaml).",
    inputSchema: {
      repoPath: z.string().optional(),
      framework: z.string().optional().describe("Override detected framework: testng | junit5 | junit4 | spock | cucumber | playwright | cypress | webdriverio | cucumber-js | jest | mocha | nightwatch | testcafe | pytest | behave | robot | nunit | xunit | mstest | specflow"),
      yamlVersion: z.enum(["auto", "0.1", "0.2"]).optional().describe("auto (default): v0.2 native framework runner for Maven/Gradle TestNG/JUnit/Spock and .NET NUnit/MSTest when no v0.1-only feature is requested; otherwise v0.1 raw discovery"),
      groups: z.string().optional().describe("v0.2 Java: only discover these TestNG groups / JUnit tags (comma-separated) via discoveryFlags -Dgroups"),
      flags: z.array(z.string()).optional().describe("v0.2: extra framework.flags passed to discovery and execution (e.g. -Dplatname=win, --project x.csproj)"),
      runson: z.enum(["linux", "mac", "mac13", "win", "win11"]).optional().describe("Target OS (default linux)"),
      runsonMatrix: z.array(z.enum(["linux", "mac", "mac13", "win", "win11"])).optional().describe("Matrix mode only: run on several OSes (sets runson: ${matrix.os})"),
      executionMode: z.enum(["autosplit", "matrix"]).optional().describe("autosplit (default) discovers tests at runtime; matrix uses an explicit list"),
      splitBy: z.enum(["class", "method", "suite", "file", "feature", "scenario", "tag", "none"]).optional(),
      concurrency: z.number().int().min(1).optional(),
      retryOnFailure: z.boolean().optional(),
      maxRetries: z.number().int().min(1).max(5).optional(),
      globalTimeout: z.number().int().min(1).max(150).optional(),
      matrixValues: z.array(z.string()).optional().describe("Explicit list for matrix mode (e.g. specific classes or tags)"),
      extraMatrix: z.record(z.string(), z.array(z.string())).optional().describe('Additional matrix axes, e.g. {"browser":["chrome","firefox"]} — exposed to tests as env vars'),
      extraEnv: z.record(z.string(), z.string()).optional(),
      extraPre: z.array(z.string()).optional().describe("Extra pre-steps appended after dependency install"),
      post: z.array(z.string()).optional(),
      runnerCommand: z.string().optional().describe("Override the runner command (use $test for the discovered item)"),
      discoveryCommand: z.string().optional().describe("Override the discovery command"),
      discoveryMode: z.enum(["local", "remote"]).optional(),
      runnerClass: z.string().optional().describe("Cucumber (Java) runner class to use"),
      embedCredentials: z.boolean().optional().describe("Default true: put the saved LambdaTest account into LT_USERNAME / LT_ACCESS_KEY. false keeps ${{ .secrets.* }} references (safe to commit)"),
      extraSysProps: z.record(z.string(), z.string()).optional().describe("Values for JVM system properties the tests read (analyze_repo sysProps), passed as -Dname=value"),
      mavenProfile: z.string().optional().describe("Maven profile id to pass as -P<id> to every mvn command (see analyze_repo mavenProfiles)"),
      tunnel: z.boolean().optional().describe("Enable LambdaTest tunnel for internal URLs"),
      jobLabel: z.array(z.string()).optional(),
      includeRuntime: z.boolean().optional(),
      outputFileName: z.string().optional().describe("File name to write, e.g. hyperexecute.yaml"),
      write: z.boolean().optional().describe("Write the YAML into the repo (default false — just return it)"),
      useLearned: z.boolean().optional().describe("Default true: start from the options this user chose repeatedly for this framework (their usual OS, VMs, split…). Explicit options always win"),
    },
  },
  async (args) => {
    try {
      const repo = resolveRepo(args.repoPath);
      // no YAML before HyperExecute analyze has run on the repo with the user's account
      const cliA = applyCliAnalyze(analyzeRepo(repo), await hyperexecuteAnalyze(repo));
      const profile = cliA.profile;
      const explicit = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
      let { options: opts, learned, team } = args.useLearned === false ? { options: explicit, learned: {}, team: {} } : withLearned(profile, explicit, repo);
      opts = { ...cliA.defaults, ...opts };
      let result;
      try {
        result = generateYaml(profile, opts);
      } catch (e) {
        if (!Object.keys(learned).length && !Object.keys(team).length) throw e;
        // a remembered choice that doesn't fit this repo (e.g. a split its framework lacks): drop this user's
        // usual settings first, then the team's
        try {
          if (!Object.keys(learned).length) throw e;
          ({ options: opts, learned } = { options: { ...team, ...explicit }, learned: {} });
          result = generateYaml(profile, opts);
        } catch {
          ({ options: opts, learned, team } = { options: explicit, learned: {}, team: {} });
          result = generateYaml(profile, opts);
        }
      }
      // proven team fixes for this framework, after the normal rules (never this machine's own fixes)
      const baseErrors = validateYaml(result.yaml, repo).errors;
      const teamFixes = args.useLearned === false ? { applied: [], skipped: [] } : applyTeamFixes(result.yaml, profile, repo, explicit, (y) => validateYaml(y, repo).errors.every((e) => baseErrors.includes(e)));
      if (teamFixes.applied.length) result.yaml = teamFixes.yaml;
      const promote = args.useLearned === false ? [] : promotionCandidates(repo, profile);
      const suggestedFixes = args.useLearned === false ? [] : personalFixSuggestions(profile);
      if (args.write) recordChoice(profile, explicit);
      const validation = validateYaml(result.yaml, repo);
      let written;
      if (args.write) {
        const out = path.join(repo, args.outputFileName || "hyperexecute.yaml");
        if (fs.existsSync(out) && !args.outputFileName) throw new Error(`${out} already exists — pass outputFileName to write elsewhere or to overwrite deliberately.`);
        fs.writeFileSync(out, result.yaml);
        written = out;
      }
      logStep(repo, written ? "Wrote the YAML" : "Generated a YAML", `${path.basename(written || "preview")} · v${result.yamlVersion} · split by ${result.splitBy}${validation.valid ? "" : " · has validation errors"}`);
      // the written file has the real key; the chat only sees it masked
      const key = embeddedCredentials(args)?.accessKey;
      const shown = key ? result.yaml.split(key).join(key.slice(0, 3) + "****") : result.yaml;
      return text(
        [
          "```yaml",
          shown.trimEnd(),
          "```",
          written ? `\nWritten to: ${written}` : "",
          `\nYAML v${result.yamlVersion} | framework: ${result.framework} | mode: ${result.executionMode} | split: ${result.splitBy} (supported: ${result.supportedSplits.join(", ")})`,
          [...cliA.notes, ...result.notes].length ? `\nNotes:\n- ${[...cliA.notes, ...result.notes].join("\n- ")}` : "",
          result.warnings.length ? `\nWarnings:\n- ${result.warnings.join("\n- ")}` : "",
          Object.keys(team).length ? `\nUsing the team's settings for this repo (${TEAM_FILE}): ${Object.entries(team).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}. Pass the option explicitly to override, or remember_for_team to change it for everyone.` : "",
          teamFixes.applied.length ? `\nTeam fixes applied (${TEAM_FILE}):\n- ${teamFixes.applied.join("\n- ")}` : "",
          teamFixes.skipped.length ? `\nTeam fixes not applied:\n- ${teamFixes.skipped.join("\n- ")}` : "",
          promote.length ? `\nA team fix worked more than once (promoteFix suggestion; ask the user before promoting):\n${promote.map((c) => `- ${c.change} (worked ${c.worked}×, for: ${c.failure}) → ${c.how}`).join("\n")}` : "",
          suggestedFixes.length ? `\nsuggestedFixes (fixes that worked on this machine for ${result.framework}; not applied, use one only if the same failure appears):\n${suggestedFixes.map((f) => `- ${f.failure}: +${f.change.added.join(" / ")}`).join("\n")}` : "",
          Object.keys(learned).length ? `\nUsing this user's usual settings for ${result.framework}: ${Object.entries(learned).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")} (learned from earlier choices; pass the option explicitly, or useLearned:false, to override).` : "",
          profile.confidence?.level !== "high" ? `\nConfidence: ${profile.confidence.level} (${profile.confidence.reasons.join("; ")})` : "",
          profile.assumptions?.length ? `\nAssumptions:\n- ${profile.assumptions.join("\n- ")}` : "",
          profile.questions?.length ? `\nConfirm with the user:\n- ${profile.questions.join("\n- ")}` : "",
          `\nValidation: ${validation.valid ? "OK" : "ISSUES"}`,
          validation.errors.length ? `- errors: ${validation.errors.join(" | ")}` : "",
          validation.warnings.length ? `- warnings: ${validation.warnings.join(" | ")}` : "",
          result.yamlVersion === "0.2"
            ? "\nNext: v0.2 discovery runs on HyperExecute (see the discovery task log) — check the discovered count on the first run."
            : "\nNext: run dry_run_test_discovery to confirm the discovery command finds the expected tests.",
        ].filter(Boolean).join("\n")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "validate_hyperexecute_yaml",
  {
    title: "Validate HyperExecute YAML",
    description: "Lint a HyperExecute YAML (file or inline): unknown keys/typos, value types, runson, v0.1/v0.2 rules (incl. the v0.2 testDiscovery 0-tests trap), autosplit/matrix consistency, $test usage, retries/timeouts, cache, hard-coded secrets, reports, and files the commands reference. Uses HE_YAML_SCHEMA too when set. USE on any YAML the user wrote or edited, and before fix_and_rerun with yamlContent. Static only — it doesn't run anything (dry_run_test_discovery does).",
    inputSchema: {
      yamlPath: z.string().optional(),
      yamlContent: z.string().optional(),
      repoPath: z.string().optional().describe("Enables repo-aware checks"),
    },
  },
  async ({ yamlPath, yamlContent, repoPath }) => {
    try {
      const content = yamlContent ?? fs.readFileSync(path.resolve(resolveRepo(repoPath), yamlPath || "hyperexecute.yaml"), "utf8");
      const r = validateYaml(content, repoPath ? resolveRepo(repoPath) : yamlPath ? path.dirname(path.resolve(resolveRepo(repoPath), yamlPath)) : undefined);
      delete r.parsed;
      logStep(resolveRepo(repoPath), "Validated the YAML", r.valid ? `valid${r.warnings.length ? `, ${r.warnings.length} warning(s)` : ""}` : `${r.errors.length} error(s)`);
      return text(r);
    } catch (e) {
      return fail(e);
    }
  }
);

function sh(cmd, cwd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile("bash", ["-c", cmd], { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr, timedOut: err?.killed })
    );
  });
}

server.registerTool(
  "dry_run_test_discovery",
  {
    title: "Dry-run test discovery",
    description:
      "Run the YAML's testDiscovery command locally (bash, in the repo) and show the discovered items, duplicates and how the first tasks expand. USE after generating a v0.1 YAML and before the first run; the count is remembered and compared with what HyperExecute actually discovers. Not for v0.2 (discovery happens on HyperExecute) or matrix YAMLs.",
    inputSchema: {
      repoPath: z.string().optional(),
      yamlPath: z.string().optional().describe("YAML to read testDiscovery/testRunnerCommand from (default hyperexecute.yaml)"),
      command: z.string().optional().describe("Explicit discovery command instead of reading the YAML"),
    },
  },
  async ({ repoPath, yamlPath, command }) => {
    try {
      const repo = resolveRepo(repoPath);
      let runner;
      if (!command) {
        const doc = YAML.parse(fs.readFileSync(path.resolve(repo, yamlPath || "hyperexecute.yaml"), "utf8"));
        command = doc?.testDiscovery?.command;
        runner = doc?.testRunnerCommand;
        if (!command) {
          if (doc?.matrix) return text({ mode: "matrix", note: "Matrix mode has no discovery; tasks are the matrix combinations.", matrix: doc.matrix, testSuites: doc.testSuites });
          throw new Error("No testDiscovery.command found in the YAML.");
        }
      }
      const r = await sh(command, repo);
      const items = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      logStep(repo, "Checked test discovery locally", `${items.length} test unit(s) found`);
      const dupes = items.length - new Set(items).size;
      // Remembered so the real run can be compared with it (see discoveryCheck in get_hyperexecute_run).
      if (r.code === 0) saveDryRun(repo, yamlPath || "hyperexecute.yaml", { command, discovered: items.length, items });
      return text({
        command,
        exitCode: r.code,
        timedOut: r.timedOut || undefined,
        discovered: items.length,
        duplicates: dupes || undefined,
        items: items.slice(0, 100),
        more: items.length > 100 ? items.length - 100 : undefined,
        stderr: r.stderr ? r.stderr.slice(0, 2000) : undefined,
        sampleTasks: runner ? items.slice(0, 3).map((t) => runner.replace(/\$test/g, t)) : undefined,
        hint: items.length === 0 ? "Nothing discovered — check paths/patterns in the command (and that it works in the target OS shell)." : undefined,
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "search_knowledge_base",
  {
    title: "Search HyperExecute knowledge base",
    description:
      "Search HyperExecute knowledge: bundled YAML reference, framework recipes, troubleshooting, golden example YAMLs (knowledge/golden), the team's gist setups, cached Confluence pages, and live Confluence (HYP) when credentials are set. When none of that answers well, it also searches the public TestMu AI docs (testmuai.com/support/docs) and returns the matching pages' text with their URLs (source \"docs\" to search them directly). Understands synonyms (\"tests not found\" ≈ \"0 tests discovered\"). USE before generating for special requirements (tunnel, reports, secrets, mobile, tags) and when a diagnosis is unknown. Keyword queries work best. Example: {query:\"cucumber tags gradle\"}.",
    inputSchema: {
      query: z.string(),
      source: z.enum(["all", "local", "confluence", "docs"]).optional().describe("Default all (TestMu AI docs only when the rest has no good answer); docs = the public TestMu AI docs only"),
      limit: z.number().int().min(1).max(20).optional(),
    },
  },
  async ({ query, source = "all", limit = 6 }) => {
    const out = {};
    const local = source === "all" || source === "local" ? searchKnowledge(query, limit) : [];
    if (source === "all" || source === "local") out.local = local.map(({ topic, section, text, source, score }) => ({ topic, section, source, score, text: text.slice(0, 4000) }));
    if (source === "all" || source === "confluence") {
      const cfg = confluenceConfig();
      if (!cfg.configured) out.confluence = { configured: false, note: "Set ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN in the MCP server env to search Confluence." };
      else {
        try {
          out.confluence = { space: cfg.spaces, results: await searchConfluence(query, { limit }) };
          if (out.confluence.results.length) out.confluence.tip = "Call get_confluence_page with an id to read the full page.";
        } catch (e) {
          out.confluence = { error: e.message, note: `Local results include ${cacheStatus().pages} cached Confluence page(s).` };
        }
      }
    }
    // not answered well above → the public TestMu AI docs
    if (source === "docs" || (source === "all" && localIsWeak(local, query) && !out.confluence?.results?.length)) {
      try {
        out.docs = await searchDocs(query, { limit: Math.min(limit, 3) });
        if (out.docs.results.length) out.docs.note = "From the public TestMu AI docs: cite the page URL when you use it. Pages are cached, so later searches find them locally.";
      } catch (e) {
        out.docs = { error: e.message };
      }
    }
    return text(out);
  }
);

server.registerTool(
  "get_confluence_page",
  {
    title: "Read Confluence page",
    description: "Fetch the full content of a Confluence page (by id or URL) from the configured knowledge-base space, converted to text with code/YAML blocks preserved.",
    inputSchema: {
      idOrUrl: z.string(),
      maxChars: z.number().int().optional(),
      cache: z.boolean().optional().describe("Default true: save the page to the local KB cache so it is searchable offline and without Atlassian credentials"),
    },
  },
  async ({ idOrUrl, maxChars, cache = true }) => {
    try {
      const page = await getConfluencePage(idOrUrl, { maxChars: 200000 });
      const cached = cache ? cacheConfluencePage(page) : null;
      const limit = maxChars || 30000;
      return text({ ...page, content: page.content.slice(0, limit), truncated: page.content.length > limit, cachedTo: cached || undefined });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "sync_gist_knowledge",
  {
    title: "Update knowledge from GitHub gists",
    description:
      "Fetch GitHub gists (field examples: HyperExecute YAMLs, discovery scripts, runTest.sh, pre/setup scripts) into the local knowledge base so search_knowledge_base finds them. Sources: a GitHub user or gist links (default HE_GISTS). Only changed gists are fetched; files that look like credentials are skipped and secrets are masked. USE when the user asks to update knowledge from gists or when gist results look stale. Nothing is sent anywhere; the cache stays on this machine.",
    inputSchema: {
      sources: z.string().optional().describe('GitHub user(s) or gist link(s), comma-separated. Default: HE_GISTS, else the shared pool (RishabhLambdaTest)'),
      force: z.boolean().optional().describe("Refetch everything, even if synced recently"),
    },
  },
  async ({ sources, force }) => {
    try {
      const src = sources || gistSources();
      const r = await syncGists({ sources: src, force: !!force });
      return text({ ...r, status: gistsStatus(), next: "search_knowledge_base now includes these gists (source: gist)." });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "knowledge_base_status",
  {
    title: "Knowledge base status",
    description: "Show which knowledge sources are available: local topics/sections and Confluence connection status (tests the credentials).",
    inputSchema: {},
  },
  async () => {
    const cfg = confluenceConfig();
    let confluence = { baseUrl: cfg.baseUrl, spaces: cfg.spaces, configured: cfg.configured, auth: cfg.mode };
    if (cfg.configured) {
      try {
        if (cfg.mode !== "bearer") confluence.user = (await whoAmI()).displayName;
        const r = await searchConfluence("hyperexecute", { limit: 1 });
        confluence.connection = "ok";
        confluence.samplePage = r[0]?.title;
        if (!r.length) confluence.connection = `authenticated, but no pages matched in space(s) ${cfg.spaces.join(", ")} — check the space key and your access`;
      } catch (e) {
        confluence.connection = e.message;
      }
    }
    return text({ update: updateInfo(), localKnowledgeDirs: KB_DIRS, localTopics: listTopics(), confluenceCache: cacheStatus(), gists: { sources: gistSources() || "off", ...gistsStatus() }, testmuDocs: docsStatus(), confluence });
  }
);

server.registerTool(
  "scan_credentials_and_reporting",
  {
    title: "Scan for hard-coded credentials and customer reporting",
    description:
      "Find hard-coded LambdaTest usernames/access keys (hub URLs with user:key@, ltOptions.put(\"accessKey\", …), LT_USERNAME=…, env fallbacks, WebdriverIO user/key) and reporting integrations that would send results to the customer's systems (their LambdaTest account, TestRail, Jira/Xray, ReportPortal, Slack/Teams, email, Allure TestOps, Cypress Cloud, Percy/Applitools, other cloud grids). Values are masked. Run before triggering any job on a customer repo.",
    inputSchema: { repoPath: z.string().optional() },
  },
  async ({ repoPath }) => {
    try {
      const repo = resolveRepo(repoPath);
      const r = scanRepo(repo);
      logStep(repo, "Scanned for credentials and reporting", `${r.credentials?.length || 0} hard-coded credential(s)${r.reporting?.length ? `, reports to ${[...new Set(r.reporting.map((x) => x.name))].slice(0, 4).join(", ")}` : ""}`);
      return text(r);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "fix_hardcoded_credentials",
  {
    title: "Replace hard-coded credentials with env vars",
    description:
      "Rewrite hard-coded LambdaTest credentials in code to read LT_USERNAME / LT_ACCESS_KEY (System.getenv / os.environ.get / process.env / Environment.GetEnvironmentVariable), so whoever runs the tests uses their own account. dryRun (default true) returns the diff only; set dryRun false to write. Config files (.properties/.json/.env) are reported, not rewritten.",
    inputSchema: { repoPath: z.string().optional(), dryRun: z.boolean().optional() },
  },
  async ({ repoPath, dryRun = true }) => {
    try {
      const repo = resolveRepo(repoPath);
      const findings = scanCredentials(repo);
      const plans = planCredentialFixes(repo, findings);
      const diff = plans.map((p) => {
        const b = p.before.split("\n");
        const a = p.after.split("\n");
        return `--- ${p.file}\n` + a.map((l, i) => (l !== b[i] ? `- ${b[i] ?? ""}\n+ ${l}` : null)).filter(Boolean).join("\n");
      });
      if (!dryRun) {
        applyCredentialFixes(repo, plans);
        logStep(repo, "Moved hard-coded credentials to environment variables", `${plans.length} file(s)`);
      }
      const manual = findings.filter((f) => !f.autoFix).map((f) => `${f.file}:${f.line} (${f.kind}) — edit by hand or read from env`);
      return text(`${dryRun ? "DRY RUN — nothing written." : `Wrote ${plans.length} file(s).`}\n\n${diff.join("\n\n") || "No auto-fixable credentials."}${manual.length ? `\n\nManual:\n- ${manual.join("\n- ")}` : ""}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "generate_lambdatest_capabilities",
  {
    title: "Find the grid connection and plan the LambdaTest change",
    description:
      "Find where the repo connects to a browser or device (driver creation, WebdriverIO/Nightwatch config, grid URLs in code or config files), say whether each already uses LambdaTest (TestMu AI), and give the exact in-place change for the chosen capabilities (browser, version, OS, resolution, build, video…, or Appium real devices) in the repo's own language, credentials from LT_USERNAME/LT_ACCESS_KEY. It never creates or edits files: tell the user where the connection is made, and change those existing lines yourself only after the user asks. Never add a new helper or connection file. listOptions:true returns the live browser/version/OS/resolution lists.",
    inputSchema: {
      repoPath: z.string().optional(),
      listOptions: z.boolean().optional(),
      browser: z.string().optional().describe("Chrome | MicrosoftEdge | Firefox | Safari"),
      version: z.string().optional().describe("latest | latest-1 | a number"),
      platform: z.string().optional().describe('e.g. "Windows 11", "macOS Sonoma", "Linux"'),
      resolution: z.string().optional(),
      build: z.string().optional(),
      project: z.string().optional(),
      video: z.boolean().optional(),
      network: z.boolean().optional(),
      console: z.boolean().optional(),
      visual: z.boolean().optional(),
      tunnel: z.boolean().optional(),
      headless: z.boolean().optional(),
      mobile: z.boolean().optional().describe("Appium on LambdaTest real devices (default: on when the repo uses Appium). Java, Python and Node"),
      mobilePlatform: z.enum(["Android", "iOS"]).optional(),
      device: z.string().optional().describe('Real device name, e.g. "Galaxy S23", "iPhone 15"'),
      platformVersion: z.string().optional(),
      app: z.string().optional().describe("lt://APP_ID of the app uploaded to LambdaTest"),
    },
  },
  async ({ repoPath, listOptions, ...opts }) => {
    try {
      const repo = resolveRepo(repoPath);
      if (listOptions) return text(await capabilityOptions(opts));
      const profile = analyzeRepo(repo);
      const conn = generateConnection(profile, opts);
      const points = planConnectionChanges(findDriverSetup(repo, profile), conn);
      logStep(repo, "Found where the tests connect", `${points.length} place(s), ${points.filter((p) => p.usesLambdaTest).length} on LambdaTest`);
      const noGrid = ["cypress", "testcafe"].includes(profile.primaryFramework);
      const out = [];
      if (!points.length) {
        out.push(noGrid
          ? `${profile.primaryFramework} runs its browsers on the HyperExecute VM itself; there is no grid connection to change.`
          : "No connection to a browser or device was found in this repo. Ask the user where the tests create their driver (a base class, a hook, a config file); do not create a new file.");
      } else {
        const onLT = points.filter((p) => p.usesLambdaTest).length;
        out.push(`Connection points (${points.length}; ${onLT} already on LambdaTest):`);
        for (const p of points) {
          out.push(`\n- ${p.file}:${p.line} [${p.kind}${p.usesLambdaTest ? ", LambdaTest" : ""}]  ${p.current}\n  Change: ${p.change}`);
          if (p.code) out.push("  ```" + conn.language + "\n" + p.code + "\n  ```");
          if (p.imports) out.push(`  Imports this needs, if the file lacks them: ${p.imports.join(", ")}`);
        }
      }
      out.push(`\nHub: ${conn.hub}\nCapabilities:\n${JSON.stringify(conn.capabilities, null, 2)}`);
      out.push(`\nNotes:\n- ${conn.notes.join("\n- ")}`);
      if (points.length) out.push("\nNext: tell the user where the connection is made and what would change. Edit only when they ask, and only those lines in the existing files: read each file first and fit the change to its code (keep its variable names, waits and hooks). Do not create a new helper or connection file. Nothing was changed.");
      return text(out.join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "optimize_hyperexecute_yaml",
  {
    title: "Optimize HyperExecute YAML",
    description:
      "Review a HyperExecute YAML for speed, cost and reliability: tests running in pre, missing/ineffective dependency cache, idle VMs (concurrency > tests), class vs method split, matrix vs autosplit, v0.1 → v0.2, excessive retries, in-runner parallelism, broad artefact uploads, remote bash discovery on Windows, macOS without need, differentialUpload for large repos. Returns ranked suggestions; pass apply (ids or \"all\") to get the optimized YAML, and write:true to save it.",
    inputSchema: {
      repoPath: z.string().optional(),
      yamlPath: z.string().optional().describe("Default hyperexecute.yaml"),
      yamlContent: z.string().optional(),
      apply: z.union([z.literal("all"), z.array(z.string())]).optional(),
      write: z.boolean().optional(),
    },
  },
  async ({ repoPath, yamlPath, yamlContent, apply, write }) => {
    try {
      const repo = resolveRepo(repoPath);
      const file = path.resolve(repo, yamlPath || "hyperexecute.yaml");
      const content = yamlContent ?? fs.readFileSync(file, "utf8");
      const profile = analyzeRepo(repo);
      const { suggestions, units, error } = optimizeYaml(content, { profile, repoPath: repo });
      if (error) throw new Error(error);
      if (!apply) {
        return text({ testUnits: units, suggestions: describeSuggestions(suggestions), next: "Call again with apply: [ids] or \"all\"." });
      }
      let { yaml: out, applied, regenerate } = applyOptimizations(content, apply, { profile, repoPath: repo });
      if (Object.keys(regenerate).length) {
        // split / mode / version changes are rebuilt by the generator rather than patched
        out = generateYaml(profile, { ...regenerate }).yaml;
        applied.push(`regenerated with ${JSON.stringify(regenerate)} (earlier patches superseded)`);
      }
      if (write && !yamlContent) fs.writeFileSync(file, out);
      const v = validateYaml(out, repo);
      return text(`Applied: ${applied.join(", ") || "none"}${write && !yamlContent ? `\nWritten: ${file}` : ""}\nValidation: ${v.valid ? "OK" : v.errors.join(" | ")}\n\n\`\`\`yaml\n${out}\`\`\``);
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- run → watch → diagnose → fix → rerun ----------

const runs = new Map(); // runId → run record (this server process only)

function ltCreds() {
  const c = loadCreds();
  if (!c)
    throw new Error("No LambdaTest account saved. Save it once in the VS Code Studio (Setup → LambdaTest account) or with the set_lambdatest_credentials tool — it's then used for every run, the YAML and the grid.");
  return c;
}

async function launch(repo, config, attempt, parent, mainConfig = config) {
  const { username, accessKey } = ltCreds();
  const cli = await ensureCli(repo);
  const id = `run-${Date.now().toString(36)}`;
  const rec = { id, repo, config, mainConfig, targeted: config !== mainConfig, attempt, parent, status: "running", tail: "", startedAt: Date.now(), result: null, diagnosis: null };
  const h = startRun({ cli, repoPath: repo, config, username, accessKey, onData: (s) => { rec.tail = (rec.tail + s).slice(-20000); } });
  rec.stop = h.stop;
  h.promise.then(async (r) => {
    rec.result = r;
    const evidence = collectEvidence({ output: r.output, repoPath: repo, since: r.startedAt, artifactsDir: r.artifactsDir });
    let yamlText = "";
    try { yamlText = fs.readFileSync(path.resolve(repo, config), "utf8"); } catch {}
    const profile = analyzeRepo(repo);
    rec.diagnosis = diagnose({ evidence, yamlText, profile, exitCode: r.exitCode, v02Name: v02FrameworkName(profile, profile.primaryFramework) });
    rec.evidence = { files: evidence.files, digest: logDigest(evidence) };
    rec.status = r.stopped ? "stopped" : rec.diagnosis.status;
    rec.discoveryCheck = checkDiscovery({ repo, yamlPath: mainConfig, yamlText, profile, output: r.output, tests: evidence.tests, targeted: rec.targeted });
    // A green job that ran nothing is the expensive failure — don't report it as passed.
    if (rec.discoveryCheck.verdict === "zero-tests" && ["passed", "passed-with-failures", "unknown"].includes(rec.status)) rec.status = "needs-attention";
    const ruleIds = rec.diagnosis.diagnoses.map((x) => x.id);
    if (!["passed", "passed-with-failures"].includes(rec.status)) {
      rec.failure = { headline: headline(evidence.text), ruleIds, title: rec.diagnosis.diagnoses[0]?.title };
      rec.learnedFix = findLearnedFix({ repo, ...rec.failure });
      // a promoted team fix that this failure points at stops being applied
      // no rule explains it: gather the evidence the agent needs to propose a YAML change
      if (["unknown", "needs-attention"].includes(rec.status)) {
        try { rec.investigation = investigate({ repo, profile, yamlText, config: mainConfig, evidence, diagnosis: rec.diagnosis, failure: rec.failure, learnedFix: rec.learnedFix }); } catch {}
      }
      rec.stoppedTeamFixes = markStoppedTeamFixes(repo, [rec.diagnosis.failedStage?.command, rec.failure.headline, ...rec.diagnosis.diagnoses.map((x) => x.evidence)].filter(Boolean).join("\n"));
    }
    // this run passed after a YAML fix: remember the failure and the change that fixed it
    const prev = parent && runs.get(parent);
    if (!r.stopped && ["passed", "passed-with-failures"].includes(rec.status) && prev?.fixedWith && prev.failure) {
      rec.learned = recordFixThatWorked({ repo, failure: prev.failure, ...prev.fixedWith, profile, jobId: rec.diagnosis.jobId });
      if (prev.fixedWith.how === "custom") recordOutcome({ event: "custom-fix-worked", runId: id, fixedRunId: prev.id, headline: mask(prev.failure.headline || "").slice(0, 300), ruleIds: prev.failure.ruleIds, framework: profile.primaryFramework, language: profile.language, change: yamlChange(prev.fixedWith.before, prev.fixedWith.after) });
      if (rec.learned) rec.promote = promotionCandidates(repo, profile);
    }
    logStep(repo, `Run ${attempt}${rec.targeted ? " (affected tests only)" : ""} finished`, `${rec.status}${rec.diagnosis.diagnoses.length ? ` · ${rec.diagnosis.diagnoses.map((x) => x.title).join("; ")}` : ""}${rec.learned ? " · fix remembered" : ""}`);
    if (!r.stopped && rec.status === "passed" && !rec.targeted) {
      rec.savedCase = saveSuccessCase({ repo, yamlText, profile, jobId: rec.diagnosis.jobId });
      const ran = readOptionsFromYaml(yamlText);
      recordChoice(profile, ran);
      rec.teamFile = recordTeamPass(repo, { options: ran, configFile: config, jobId: rec.diagnosis.jobId, framework: profile.primaryFramework });
    }
    if (!r.stopped) {
      rec.feedbackFile = recordUnmatched({ source: "run", runId: id, diagnosis: { ...rec.diagnosis, status: rec.status }, logText: evidence.text, profile, yamlText });
      recordOutcome({ event: "result", runId: id, parent, attempt, status: rec.status, ruleIds: rec.diagnosis.diagnoses.map((d) => d.id), discovery: rec.discoveryCheck.verdict, framework: profile.primaryFramework });
    }
  });
  runs.set(id, rec);
  logStep(repo, `Started run ${attempt}`, config);
  return rec;
}

// the choices a YAML embodies, for learning from a run that passed
function readOptionsFromYaml(text) {
  try {
    const d = YAML.parse(String(text).replace(/\$\{\{[^}]*\}\}/g, "x")) || {};
    return { runson: typeof d.runson === "string" && !d.runson.includes("$") ? d.runson : undefined, concurrency: d.concurrency, retryOnFailure: d.retryOnFailure, maxRetries: d.maxRetries, globalTimeout: d.globalTimeout, tunnel: d.tunnel || undefined };
  } catch {
    return {};
  }
}

function runView(rec, tailChars = 3000) {
  const d = rec.diagnosis ? describeDiagnosis(rec.diagnosis) : null;
  return {
    runId: rec.id,
    attempt: rec.attempt,
    status: rec.status,
    elapsedSec: Math.round(((rec.result?.finishedAt || Date.now()) - rec.startedAt) / 1000),
    exitCode: rec.result?.exitCode ?? null,
    jobUrl: d?.jobUrl || (rec.tail.match(/https:\/\/[\w.-]*hyperexecute[\w.-]*\/[^\s"')]+/i) || [])[0] || null,
    targetedRerun: rec.targeted || undefined,
    diagnosis: d,
    discoveryCheck: rec.discoveryCheck && rec.discoveryCheck.verdict !== "ok" ? rec.discoveryCheck : rec.discoveryCheck ? { verdict: "ok", platformDiscovered: rec.discoveryCheck.platformDiscovered, executedTests: rec.discoveryCheck.executedTests } : undefined,
    savedAsAccuracyCase: rec.savedCase ? "This passing setup was saved as an accuracy case, so future versions are checked against it." : undefined,
    fixedBefore: rec.learnedFix ? { how: rec.learnedFix.how === "rules" ? "a built-in rule's fix" : "a YAML change", worked: rec.learnedFix.worked, from: rec.learnedFix.from, change: rec.learnedFix.change, note: "This failure was fixed before by this change and the next run passed. Try the same change first (fix_and_rerun_hyperexecute with yamlContent), after checking it fits this YAML." } : undefined,
    learned: rec.learned ? "The fix applied before this run made it pass: it's remembered (here and in the repo's team memory) for the next time this failure appears." : undefined,
    promoteFix: rec.promote?.length ? { suggestions: rec.promote, note: "These team fixes worked more than once. Ask the user; on yes, remember_for_team with promoteFix applies the fix to every new YAML for the same framework and language." } : undefined,
    teamFixStopped: rec.stoppedTeamFixes?.length ? `This failure points at what a promoted team fix added, so it is no longer applied: ${rec.stoppedTeamFixes.join("; ")}. remember_for_team with promoteFix re-enables it.` : undefined,
    teamMemory: rec.teamFile ? `Team memory updated (${TEAM_FILE}): commit it so teammates' agents start from this passing setup.` : undefined,
    savedForReview: rec.feedbackFile ? "The unexplained part of this failure was saved (masked) for rule review — see review_diagnosis_feedback." : undefined,
    logFiles: rec.evidence?.files,
    logTail: rec.status === "running" ? rec.tail.slice(-tailChars) : undefined,
    logDigest: rec.status !== "running" && d && ["unknown", "needs-attention"].includes(d.status) ? rec.evidence?.digest : undefined,
    investigation: rec.investigation,
    next:
      rec.status === "running" ? "Call get_hyperexecute_run again in a minute or two." :
      rec.discoveryCheck?.verdict === "zero-tests" && rec.status !== "fixable" ? "The job ran 0 tests. Fix discovery (dry_run_test_discovery, validate_hyperexecute_yaml), then rerun with fix_and_rerun_hyperexecute and yamlContent." :
      rec.status === "fixable" ? "Call fix_and_rerun_hyperexecute with this runId to apply the YAML fixes and start the next attempt." :
      d?.failedStage && ["unknown", "needs-attention"].includes(rec.status) ? "The pre step failed before any test ran — a YAML/environment problem, not a test failure. Read diagnosis.failedStage (command + log) and logDigest, change the pre command or runtime in the YAML (validate it), then call fix_and_rerun_hyperexecute with yamlContent. investigation lists the repo files and the repo's own YAMLs that bear on it." :
      rec.status === "fixable-tests" ? "Some tests failed for YAML/environment reasons (see diagnosis.tests.list). Call fix_and_rerun_hyperexecute — it fixes the YAML and reruns only those tests; code failures are left alone." :
      rec.status === "needs-input" ? `Tests need environment values the YAML doesn't have: ${(d?.needsValue || []).join(", ")}. Ask the user for them, then call fix_and_rerun_hyperexecute with values.` :
      rec.status === "test-failures" ? "The tests themselves failed — not a YAML problem. Report them; don't rerun." :
      ["unknown", "needs-attention"].includes(rec.status) && rec.investigation ? "No rule explains this failure. Use investigation (failed step, the repo files it depends on, the repo's own HyperExecute YAMLs, knowledge) to find the cause; if it's in the YAML, validate the change and call fix_and_rerun_hyperexecute with yamlContent. If it's in test code, the app, the account or the platform, report it and stop." :
      ["unknown", "needs-attention"].includes(rec.status) ? "Read logDigest, decide on a YAML change (validate it), then call fix_and_rerun_hyperexecute with yamlContent." : undefined,
  };
}

server.registerTool(
  "set_lambdatest_credentials",
  {
    title: "Save LambdaTest credentials (once)",
    description:
      "Verify and save the user's LambdaTest username and access key to ~/.hyperexecute-studio/credentials.json (mode 600), shared with the VS Code Studio. After this, every run, the YAML's LT_USERNAME/LT_ACCESS_KEY and the grid connection use them without asking again. Prefer the Studio's Setup card, which keeps the key out of the chat.",
    inputSchema: { username: z.string(), accessKey: z.string() },
  },
  async ({ username, accessKey }) => {
    const v = await verifyCreds(username.trim(), accessKey.trim());
    if (!v.ok) return fail(new Error(v.text));
    saveCreds({ username: username.trim(), accessKey: accessKey.trim() });
    return text(`${v.text}. Saved for all future runs (${CREDS_FILE}).`);
  }
);

server.registerTool(
  "lambdatest_credentials_status",
  {
    title: "LambdaTest credentials status",
    description: "Which LambdaTest account runs will use (never shows the key) and whether it still works.",
    inputSchema: { verify: z.boolean().optional() },
  },
  async ({ verify }) => {
    const c = loadCreds();
    if (!c) return text({ saved: false, next: "Save it once: Studio Setup card, or set_lambdatest_credentials." });
    const out = { saved: true, username: c.username, source: c.source, accessKey: c.accessKey.slice(0, 3) + "****" };
    if (verify) out.check = (await verifyCreds(c.username, c.accessKey)).text;
    return text(out);
  }
);

server.registerTool(
  "run_hyperexecute_job",
  {
    title: "Run HyperExecute job (watched)",
    description:
      "Start a HyperExecute job for the repo with the CLI (downloaded automatically if needed) and watch it. Returns a runId immediately; poll get_hyperexecute_run for progress and, when finished, a diagnosis of any failure with proposed YAML fixes. Uses the saved LambdaTest account (set once via the Studio or set_lambdatest_credentials) for the CLI and fills the YAML's LT_USERNAME/LT_ACCESS_KEY secrets for the VMs in a temporary copy. Scan for hard-coded customer credentials first (scan_credentials_and_reporting).",
    inputSchema: { repoPath: z.string().optional(), yamlPath: z.string().optional().describe("Default hyperexecute.yaml") },
  },
  async ({ repoPath, yamlPath }) => {
    try {
      const repo = resolveRepo(repoPath);
      const config = yamlPath || "hyperexecute.yaml";
      if (!fs.existsSync(path.resolve(repo, config))) throw new Error(`${config} not found in ${repo} — generate and write it first.`);
      const v = validateYaml(fs.readFileSync(path.resolve(repo, config), "utf8"), repo);
      if (!v.valid) throw new Error(`Fix validation errors before running: ${v.errors.join(" | ")}`);
      return text(runView(await launch(repo, config, 1, null)));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "get_hyperexecute_run",
  {
    title: "Check a watched HyperExecute run",
    description: "Status of a run from run_hyperexecute_job: live log tail while running; when finished, the diagnosis (passed / fixable / fixable-tests / needs-input / test-failures / auth-error / needs-attention / unknown) with proposed fixes, plus discoveryCheck comparing expected vs actual discovered/executed tests (a 0-test \"pass\" is reported as needs-attention). waitSeconds (max 240) blocks until done. Follow the returned `next`.",
    inputSchema: { runId: z.string(), waitSeconds: z.number().int().min(0).max(240).optional() },
  },
  async ({ runId, waitSeconds = 0 }) => {
    const rec = runs.get(runId);
    if (!rec) return fail(new Error(`Unknown runId ${runId} (runs live only as long as this server process).`));
    const until = Date.now() + waitSeconds * 1000;
    while (rec.status === "running" && Date.now() < until) await new Promise((r) => setTimeout(r, 2000));
    return text(runView(rec));
  }
);

server.registerTool(
  "fix_and_rerun_hyperexecute",
  {
    title: "Apply fixes and rerun",
    description:
      "Apply a finished run's proposed YAML fixes (all, or fixIds) — or your own validated yamlContent — write the YAML and start the next attempt; when only some tests failed for YAML reasons, reruns just those. Pass values:{VAR:\"...\"} for needsValue env vars (ask the user, never invent). REFUSES for test-failures (code bugs), auth errors and after maxAttempts (default 3). Every fix and override is logged for review_diagnosis_feedback.",
    inputSchema: {
      runId: z.string(),
      fixIds: z.array(z.string()).optional(),
      yamlContent: z.string().optional().describe("Your own corrected YAML (for needs-attention / unknown diagnoses)"),
      rerun: z.boolean().optional().describe("Default true"),
      values: z.record(z.string(), z.string()).optional().describe("Values for environment variables the diagnosis lists in needsValue (ask the user)"),
      onlyAffected: z.boolean().optional().describe("Default true: when only some tests failed for YAML reasons, rerun just those tests"),
      maxAttempts: z.number().int().min(1).max(10).optional(),
    },
  },
  async ({ runId, fixIds, yamlContent, rerun = true, maxAttempts = 3, values = {}, onlyAffected = true }) => {
    try {
      const rec = runs.get(runId);
      if (!rec) throw new Error(`Unknown runId ${runId}`);
      if (rec.status === "running") throw new Error("Run is still in progress.");
      if (["passed", "passed-with-failures"].includes(rec.status) && !yamlContent) throw new Error("Run passed — nothing to fix.");
      if (["test-failures", "auth-error"].includes(rec.status) && !yamlContent) throw new Error(`Diagnosis is ${rec.status}; changing the YAML won't help.`);
      const missing = (rec.diagnosis?.needsValue || []).filter((n) => !values[n]);
      if (rec.status === "needs-input" && missing.length && !yamlContent) throw new Error(`Provide values for: ${missing.join(", ")}`);
      if (rec.attempt >= maxAttempts) throw new Error(`Reached ${maxAttempts} attempts — stopping. Review the diagnosis manually.`);
      const file = path.resolve(rec.repo, rec.mainConfig);
      const before = fs.readFileSync(file, "utf8");
      let next = yamlContent;
      let applied = ["custom YAML"];
      if (!next) {
        const r = applyDiagnosisFixes(before, rec.diagnosis, fixIds, values);
        next = r.yaml;
        applied = r.applied;
        if (Object.keys(r.options).length) {
          const profile = analyzeRepo(rec.repo);
          next = applyDiagnosisFixes(generateYaml(profile, r.options).yaml, rec.diagnosis, rec.diagnosis._fixes.filter((f) => f.patch).map((f) => f.id)).yaml;
        }
      }
      const v = validateYaml(next, rec.repo);
      if (!v.valid) throw new Error(`Fixed YAML doesn't validate: ${v.errors.join(" | ")}`);
      // don't spend an attempt on nothing, or on a change this chain of attempts already tried
      const key = changeKey(before, next);
      if (!key) throw new Error("The YAML is unchanged — rerunning would fail the same way. Change what the evidence points at, or report the failure.");
      const tried = [];
      for (let p = rec; p; p = p.parent && runs.get(p.parent)) if (p.fixedWith?.key) tried.push(p.fixedWith.key);
      if (tried.includes(key)) throw new Error("This exact change was already tried in this chain of attempts and the failure came back. Stopping: report the failure with the evidence instead.");
      fs.writeFileSync(file, next);
      rec.fixedWith = { before, after: next, how: yamlContent ? "custom" : "rules", applied, key };
      logStep(rec.repo, "Fixed the YAML", applied.join("; "));
      const out = { applied, written: file };
      const ruleIds = (rec.diagnosis?.diagnoses || []).map((x) => x.id).concat((rec.diagnosis?.tests?.list || []).map((t) => t.rule).filter(Boolean));
      if (rerun) {
        const d = rec.diagnosis;
        const sels = d ? fixableSelectors(d, values) : [];
        const targeted = !yamlContent && onlyAffected && d?.status === "fixable-tests" && !d.fullRerunNeeded && sels.length;
        if (targeted) {
          const profile = analyzeRepo(rec.repo);
          const rerunYaml = buildTargetedRerun({ fixedYaml: next, selectors: sels, profile, generate: (o) => generateYaml(profile, o).yaml });
          const rerunFile = ".hyperexecute-rerun.yaml";
          fs.writeFileSync(path.resolve(rec.repo, rerunFile), rerunYaml);
          out.rerunOnly = [...sels];
          const skipped = (d.needsValue || []).filter((n) => !values[n]);
          if (skipped.length) out.waitingForValues = skipped;
          out.leftAlone = d.tests.list.filter((t) => t.cause !== "yaml").map((t) => `${t.label} (${t.cause}: ${t.reason})`);
          out.nextRun = runView(await launch(rec.repo, rerunFile, rec.attempt + 1, rec.id, rec.mainConfig));
        } else out.nextRun = runView(await launch(rec.repo, rec.mainConfig, rec.attempt + 1, rec.id));
      }
      // custom YAML on a run that had proposed fixes = those fixes were overridden (a signal the rule may be wrong)
      recordOutcome({ event: yamlContent ? "custom-yaml" : "auto-fix", runId, nextRunId: out.nextRun?.runId, ruleIds: [...new Set(yamlContent ? ruleIds.filter(() => rec.diagnosis?._fixes?.length) : ruleIds)], fixIds: fixIds || null, applied });
      return text(out);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "diagnose_hyperexecute_logs",
  {
    title: "Diagnose HyperExecute logs",
    description: "Diagnose a HyperExecute failure from pasted logs or a downloaded log file/folder against the repo's YAML; returns the diagnosis and, when fixable, the corrected YAML (write:true saves it). USE when the job was run outside this server (dashboard, CI). For runs started with run_hyperexecute_job use get_hyperexecute_run instead. Unrecognized failures are saved (masked) for review_diagnosis_feedback.",
    inputSchema: { repoPath: z.string().optional(), logText: z.string().optional(), logPath: z.string().optional(), yamlPath: z.string().optional(), write: z.boolean().optional() },
  },
  async ({ repoPath, logText, logPath, yamlPath, write }) => {
    try {
      const repo = resolveRepo(repoPath);
      let evidence = collectEvidence({ output: logText || "" });
      if (logPath) {
        const p = path.resolve(repo, logPath);
        // a folder keeps its structure, so the stage logs (logs/<job>/tasks/<task>/pre) are told apart
        evidence = fs.statSync(p).isDirectory() ? collectEvidence({ output: logText || "", repoPath: p, since: 1 }) : collectEvidence({ output: (logText || "") + fs.readFileSync(p, "utf8") });
      }
      const text_ = evidence.text;
      if (!text_.trim()) throw new Error("Pass logText or logPath.");
      const file = path.resolve(repo, yamlPath || "hyperexecute.yaml");
      const yamlText = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const profile = analyzeRepo(repo);
      const d = diagnose({ evidence, yamlText, profile, exitCode: 1, v02Name: v02FrameworkName(profile, profile.primaryFramework) });
      const out = { diagnosis: describeDiagnosis(d) };
      const seen = findLearnedFix({ repo, headline: headline(text_), ruleIds: d.diagnoses.map((x) => x.id) });
      if (seen) out.fixedBefore = { worked: seen.worked, from: seen.from, change: seen.change, note: "This failure was fixed before by this YAML change and the next run passed. Try it first, after checking it fits this YAML." };
      logStep(repo, "Diagnosed a job log", d.diagnoses.map((x) => x.title).join("; ") || d.status);
      if (recordUnmatched({ source: "pasted-logs", diagnosis: d, logText: text_, profile, yamlText })) out.savedForReview = "Unrecognized failure saved (masked) for rule review — see review_diagnosis_feedback.";
      if (d._fixes.length && yamlText) {
        const r = applyDiagnosisFixes(yamlText, d);
        let next = r.yaml;
        if (Object.keys(r.options).length) next = applyDiagnosisFixes(generateYaml(profile, r.options).yaml, d, d._fixes.filter((f) => f.patch).map((f) => f.id)).yaml;
        out.applied = r.applied;
        out.fixedYaml = next;
        if (write) { fs.writeFileSync(file, next); out.written = file; }
      } else if (!d.diagnoses.length || d.failedStage) out.logDigest = logDigest(evidence);
      return text(out);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "generate_ci_pipeline",
  {
    title: "Generate a CI pipeline that runs HyperExecute",
    description:
      "Write the CI file that runs the repo's HyperExecute YAML from the customer's own CI: GitHub Actions, GitLab CI, Jenkins or Azure DevOps. Downloads the CLI, takes LT_USERNAME / LT_ACCESS_KEY from the CI's secret store (filling ${{ .secrets.* }} references into a temporary copy when the YAML uses them), fails the build when the job fails, and keeps the job logs as an artifact. USE after the YAML is written and validated, when the user wants runs on every push or from CI. write:true saves it (refuses to overwrite).",
    inputSchema: {
      repoPath: z.string().optional(),
      ci: z.enum(Object.keys(CI_SYSTEMS)).describe("github | gitlab | jenkins | azure"),
      yamlPath: z.string().optional().describe("Default hyperexecute.yaml"),
      branch: z.string().optional().describe("Branch that triggers runs (default main)"),
      write: z.boolean().optional(),
    },
  },
  async ({ repoPath, ci, yamlPath = "hyperexecute.yaml", branch, write }) => {
    try {
      const repo = resolveRepo(repoPath);
      const yamlFile = path.resolve(repo, yamlPath);
      const yaml = fs.existsSync(yamlFile) ? fs.readFileSync(yamlFile, "utf8") : "";
      const p = generatePipeline({ ci, configFile: yamlPath, yaml, branch });
      let written = "";
      if (write) {
        const out = path.join(repo, p.path);
        if (fs.existsSync(out)) throw new Error(`${p.path} already exists — not overwriting. Merge the job in by hand.`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, p.content);
        written = `\nWritten: ${p.path}`;
      }
      logStep(repo, write ? "Added a CI pipeline" : "Prepared a CI pipeline", `${ci}${write ? ` · ${p.path}` : ""}`);
      const missing = yaml ? "" : `\n(${yamlPath} not found yet — generate and write it first)`;
      return text(`${p.name} → ${p.path}${written}${missing}\n\n\`\`\`\n${p.content}\`\`\`\n\nNotes:\n- ${p.notes.join("\n- ")}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "remember_for_team",
  {
    title: "Remember a setting or note for the whole team",
    description:
      `Save what the user decided for this repo into ${TEAM_FILE} (committed with the repo), so every teammate's agent starts from it: options (runson, concurrency, splitBy, yamlVersion, mavenProfile, tags, extraEnv…) and notes ("staging needs the tunnel", "never split the checkout suite"). USE when the user says "always…", "for this repo use…", "remember that…", or corrects a generated YAML in a way that should stick. Passing runs update it automatically. Credentials are refused. Not for this user's personal defaults (those are learned automatically).`,
    inputSchema: {
      repoPath: z.string().optional(),
      options: z.record(z.string(), z.any()).optional().describe(`Options to pin for the team; allowed: ${TEAM_OPTIONS.join(", ")}`),
      unset: z.array(z.string()).optional().describe("Option names to stop pinning"),
      note: z.string().optional().describe("A short fact every teammate's agent should know about this repo"),
      removeNote: z.string().optional().describe("Remove the note that matches this text"),
      promoteFix: z.string().optional().describe("Promote (or re-enable) a team fix from a promoteFix suggestion: new YAMLs for the same framework and language get it"),
    },
  },
  async ({ repoPath, options, unset, note, removeNote, promoteFix }) => {
    try {
      const repo = resolveRepo(repoPath);
      const promoted = promoteFix ? promoteTeamFix(repo, promoteFix) : undefined;
      if (promoted && !options && !unset && !note && !removeNote) return text({ file: path.join(repo, TEAM_FILE), promoted, next: `Commit ${TEAM_FILE} so the team gets it.` });
      const r = rememberForTeam(repo, { options, unset, note, removeNote });
      logStep(repo, "Saved a team decision", [note, options && Object.keys(options).join(", ")].filter(Boolean).join(" · "));
      return text({ file: r.file, promoted, options: r.memory.options, notes: r.memory.notes, rejected: r.rejected.length ? r.rejected : undefined, next: `Commit ${TEAM_FILE} so the team gets it.` });
    } catch (e) {
      return fail(e);
    }
  }
);

// Everything known about this repo's setup in this session, for the Confluence record.
function setupSession(repo, yamlPath = "hyperexecute.yaml") {
  const file = path.resolve(repo, yamlPath);
  const yaml = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const profile = analyzeRepo(repo);
  const steps = activity.get(repo) || [];
  const mine = [...runs.values()].filter((r) => r.repo === repo).sort((a, b) => a.startedAt - b.startedAt);
  const scanned = steps.some((a) => /Scanned for credentials/.test(a.step));
  const scan = scanned ? scanRepo(repo) : null;
  let connection = [];
  try { connection = findDriverSetup(repo, profile); } catch {}
  return {
    repoName: path.basename(repo),
    profile: summarizeProfile(profile, 10),
    yaml,
    yamlFile: yamlPath,
    validation: yaml ? validateYaml(yaml, repo) : null,
    runs: mine.map((r) => {
      const v = runView(r);
      return { attempt: r.attempt, status: r.status, targeted: r.targeted, durationSec: v.elapsedSec, jobUrl: v.jobUrl, tests: r.diagnosis?.tests, changes: r.fixedWith?.applied, problems: ["passed", "running"].includes(r.status) ? [] : r.diagnosis?.diagnoses || [], headline: r.failure?.headline };
    }),
    activity: steps,
    connection,
    scan: scan && { credentials: scan.credentials?.length || 0, credentialsFixed: steps.some((a) => /Moved hard-coded credentials/.test(a.step)) ? (scan.credentials || []).filter((c) => c.autoFix).length : 0, reporting: [...new Set((scan.reporting || []).map((x) => x.name).filter(Boolean))] },
    team: readTeamMemory(repo),
    learned: mine.map((r) => r.learned).filter(Boolean),
  };
}

server.registerTool(
  "publish_to_confluence",
  {
    title: "Add this setup to Confluence",
    description:
      "Create a Confluence page that documents what was done for this repo in this session: analysis, the HyperExecute YAML (credentials as secret references), checks, every run with its status and job link, problems and how they were fixed, fixes the agent learned, grid connection points, credentials/reporting findings, team decisions and next steps. USE when the user asks to document the work, \"add to Confluence\" or share it with the team. preview:true returns the document without creating anything. Needs ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN; the page always goes to the configured space (CONFLUENCE_PUBLISH_SPACE, default HYP), under parentId if given. Each call creates a new page.",
    inputSchema: {
      repoPath: z.string().optional(),
      yamlPath: z.string().optional().describe("Default hyperexecute.yaml"),
      title: z.string().optional().describe("Default: HyperExecute setup: <repo> (<date time>)"),
      parentId: z.string().optional().describe("Id of the page to create it under"),
      preview: z.boolean().optional().describe("Return the document (Markdown) without creating a page"),
    },
  },
  async ({ repoPath, yamlPath, title, parentId, preview }) => {
    try {
      const repo = resolveRepo(repoPath);
      const doc = buildSetupReport(setupSession(repo, yamlPath), { title });
      if (preview) return text(`${doc.markdown}\n\n---\nNot published. Call again without preview to create the page "${doc.title}".`);
      const page = await createConfluencePage({ title: doc.title, storage: doc.storage, parentId });
      // the page becomes searchable knowledge too, so later sessions learn from it
      cacheConfluencePage({ id: page.id, title: page.title, url: page.url, space: page.space, version: 1, content: doc.markdown });
      logStep(repo, "Added the setup to Confluence", page.url);
      return text({ created: page.title, url: page.url, space: page.space, note: "The page is also saved to the local knowledge base, so search_knowledge_base finds it." });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "review_diagnosis_feedback",
  {
    title: "Review unrecognized failures and fix outcomes",
    description:
      "Summarize what the diagnosis rules missed: failures saved (masked, locally) when a run or pasted log came back unknown/needs-attention or had unexplained tests, grouped by signature with counts, plus per-rule fix outcomes (applied, overridden with custom YAML, next attempt passed / failed the same way). USE for the weekly rule review: turn recurring groups into doctor.js rules, then markReviewed. Not for diagnosing a single run.",
    inputSchema: {
      sinceDays: z.number().int().min(1).max(365).optional().describe("Default 30"),
      markReviewed: z.array(z.string()).optional().describe("Signatures to move to reviewed/ (after adding a rule for them)"),
      includeReviewed: z.boolean().optional(),
    },
  },
  async ({ sinceDays, markReviewed: sigs, includeReviewed }) => {
    try {
      const moved = sigs?.length ? markReviewed(sigs) : undefined;
      return text({ ...reviewFeedback({ sinceDays, includeReviewed }), moved });
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- resources: bundled knowledge ----------

for (const [topic] of Object.entries(listTopics())) {
  server.registerResource(
    `kb-${topic}`,
    `hyperexecute://knowledge/${topic}`,
    { title: `HyperExecute KB: ${topic}`, mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, text: getTopic(topic) || "" }] })
  );
}

// ---------- prompt: end-to-end workflow ----------

server.registerPrompt(
  "create_hyperexecute_yaml",
  {
    title: "Create HyperExecute YAML for this repo",
    description: "Guided workflow: analyze repo → consult KB → generate → validate → dry-run discovery.",
    argsSchema: { repoPath: z.string().optional(), requirements: z.string().optional() },
  },
  ({ repoPath, requirements }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Create a HyperExecute YAML for the repo at ${repoPath || "the current workspace"}.
${requirements ? `Customer requirements: ${requirements}\n` : ""}
Steps:
1. Call analyze_repo and summarise the detected stack, tests, and warnings. If confidence isn't high, show the assumptions and ask the user its questions before going on. Call scan_credentials_and_reporting and report hard-coded credentials and customer-side reporting (offer fix_hardcoded_credentials).
2. Call search_knowledge_base for the detected framework (and any special requirements such as tunnel, secrets, reports, mobile) — prefer Confluence guidance where it conflicts with the bundled notes.
3. Read the key config files yourself (runner classes, driver/capability setup, config.properties / playwright.config / wdio.conf) to confirm how tests get their browser/grid and credentials.
4. Call generate_hyperexecute_yaml with the right options (framework, runson, splitBy, concurrency).
5. Call dry_run_test_discovery and check the discovered count matches expectations.
6. Call optimize_hyperexecute_yaml and apply the worthwhile suggestions.
7. If tests don't already connect to LambdaTest, run generate_lambdatest_capabilities, show the user where the connection is made, and change those lines in place only if they ask (never add a helper file).
8. Resolve every validation error and placeholder, then write the file (write: true).
9. If the user wants it run: run_hyperexecute_job, poll get_hyperexecute_run, and on a fixable failure call fix_and_rerun_hyperexecute (max 3 attempts). Never rerun for test failures.`,
        },
      },
    ],
  })
);

await server.connect(new StdioServerTransport());
startUpdateCheck();

// Keep the shared gist knowledge fresh: refresh in the background when the last sync is older than 6 hours.
if (gistSources()) syncGists().catch((e) => console.error(`gist sync: ${e.message}`));
