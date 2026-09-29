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
import { generateYaml } from "./generator.js";
import { validateYaml } from "./validator.js";
import { searchKnowledge, listTopics, getTopic, KB_DIRS } from "./knowledge.js";
import { confluenceConfig, searchConfluence, getConfluencePage, whoAmI } from "./confluence.js";

const server = new McpServer({ name: "hyperexecute-yaml", version: "1.0.0" });

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message || e}` }] });

// Default repo = HE_DEFAULT_REPO or the first workspace root the client opened the server in.
const resolveRepo = (p) => path.resolve(p || process.env.HE_DEFAULT_REPO || process.cwd());

// ---------- tools ----------

server.registerTool(
  "analyze_repo",
  {
    title: "Analyze automation repo",
    description:
      "Scan a test-automation repository and detect language, build tool, test framework (TestNG, JUnit, Cucumber, Playwright, Cypress, WebdriverIO, pytest, Behave, Robot, NUnit, SpecFlow…), test classes/files/features/scenarios, tags, env vars the code reads, grid/hub usage, reports and existing HyperExecute YAMLs. Run this first.",
    inputSchema: { repoPath: z.string().optional().describe("Absolute path to the repo (defaults to the workspace folder)") },
  },
  async ({ repoPath }) => {
    try {
      return text(summarizeProfile(analyzeRepo(resolveRepo(repoPath))));
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
      "Generate a HyperExecute YAML for the repo from its detected framework. Supports autosplit (dynamic test discovery) and matrix modes, split by class/method/suite/tag (Java), feature/scenario/tag (Cucumber/Behave), file/tag (JS, Robot), file/method/tag (pytest). Returns the YAML plus notes/warnings; optionally writes it into the repo. Call search_knowledge_base first when the user has special requirements.",
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
      tunnel: z.boolean().optional().describe("Enable LambdaTest tunnel for internal URLs"),
      jobLabel: z.array(z.string()).optional(),
      includeRuntime: z.boolean().optional(),
      outputFileName: z.string().optional().describe("File name to write, e.g. hyperexecute.yaml"),
      write: z.boolean().optional().describe("Write the YAML into the repo (default false — just return it)"),
    },
  },
  async (args) => {
    try {
      const repo = resolveRepo(args.repoPath);
      const profile = analyzeRepo(repo);
      const result = generateYaml(profile, args);
      const validation = validateYaml(result.yaml, repo);
      let written;
      if (args.write) {
        const out = path.join(repo, args.outputFileName || "hyperexecute.yaml");
        if (fs.existsSync(out) && !args.outputFileName) throw new Error(`${out} already exists — pass outputFileName to write elsewhere or to overwrite deliberately.`);
        fs.writeFileSync(out, result.yaml);
        written = out;
      }
      return text(
        [
          "```yaml",
          result.yaml.trimEnd(),
          "```",
          written ? `\nWritten to: ${written}` : "",
          `\nYAML v${result.yamlVersion} | framework: ${result.framework} | mode: ${result.executionMode} | split: ${result.splitBy} (supported: ${result.supportedSplits.join(", ")})`,
          result.notes.length ? `\nNotes:\n- ${result.notes.join("\n- ")}` : "",
          result.warnings.length ? `\nWarnings:\n- ${result.warnings.join("\n- ")}` : "",
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
    description: "Lint a HyperExecute YAML (file path or inline content): schema keys, typos, runson values, autosplit/matrix consistency, $test usage, retries/timeouts, cache config, hard-coded secrets, report config, and repo-aware checks (files referenced exist).",
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
      "Run the testDiscovery command locally in the repo (from a YAML file or an explicit command) and show what HyperExecute will split on, plus how the first tasks' runner commands expand. Read-only commands only; runs with bash in the repo directory.",
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
      const dupes = items.length - new Set(items).size;
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
      "Search HyperExecute knowledge: the bundled YAML reference / framework recipes / troubleshooting notes, plus the live Confluence space (default HYP on lambdatest.atlassian.net) when Atlassian credentials are configured. Use for YAML keys, framework-specific setup, report config, tunnel, secrets, errors, customer-specific conventions.",
    inputSchema: {
      query: z.string(),
      source: z.enum(["all", "local", "confluence"]).optional().describe("Default all"),
      limit: z.number().int().min(1).max(20).optional(),
    },
  },
  async ({ query, source = "all", limit = 6 }) => {
    const out = {};
    if (source !== "confluence") out.local = searchKnowledge(query, limit).map(({ topic, section, text }) => ({ topic, section, text: text.slice(0, 4000) }));
    if (source !== "local") {
      const cfg = confluenceConfig();
      if (!cfg.configured) out.confluence = { configured: false, note: "Set ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN in the MCP server env to search Confluence." };
      else {
        try {
          out.confluence = { space: cfg.spaces, results: await searchConfluence(query, { limit }) };
          if (out.confluence.results.length) out.confluence.tip = "Call get_confluence_page with an id to read the full page.";
        } catch (e) {
          out.confluence = { error: e.message };
        }
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
    inputSchema: { idOrUrl: z.string(), maxChars: z.number().int().optional() },
  },
  async ({ idOrUrl, maxChars }) => {
    try {
      return text(await getConfluencePage(idOrUrl, { maxChars }));
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
    return text({ localKnowledgeDirs: KB_DIRS, localTopics: listTopics(), confluence });
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
1. Call analyze_repo and summarise the detected stack, tests, and warnings.
2. Call search_knowledge_base for the detected framework (and any special requirements such as tunnel, secrets, reports, mobile) — prefer Confluence guidance where it conflicts with the bundled notes.
3. Read the key config files yourself (runner classes, driver/capability setup, config.properties / playwright.config / wdio.conf) to confirm how tests get their browser/grid and credentials.
4. Call generate_hyperexecute_yaml with the right options (framework, runson, splitBy, concurrency).
5. Call dry_run_test_discovery and check the discovered count matches expectations.
6. Resolve every validation error and placeholder, then write the file (write: true) and give the CLI command to run it.`,
        },
      },
    ],
  })
);

await server.connect(new StdioServerTransport());
