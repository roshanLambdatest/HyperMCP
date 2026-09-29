// Turns a natural-language request ("run on windows with 10 VMs, split by scenario") into a plan:
// generator option changes (preferred) or a full YAML rewrite, plus a short reply.
// Backends: Claude Code CLI (`claude -p`), VS Code language models, Anthropic API, or offline rules.

const vscode = require("vscode");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { z } = require("zod");

const OS = ["linux", "mac", "mac13", "win", "win11"];
const SPLITS = ["class", "method", "suite", "file", "feature", "scenario", "tag", "none"];

const PlanSchema = z.object({
  reply: z.string().describe("Short answer to the user: what changed and why (or the answer to their question)."),
  action: z.enum(["update_options", "replace_yaml", "answer_only"]),
  options: z.object({
    framework: z.string().nullable(),
    yamlVersion: z.enum(["auto", "0.1", "0.2"]).nullable(),
    runson: z.enum(OS).nullable(),
    runsonMatrix: z.array(z.enum(OS)).nullable(),
    executionMode: z.enum(["autosplit", "matrix"]).nullable(),
    splitBy: z.enum(SPLITS).nullable(),
    concurrency: z.number().int().nullable(),
    retryOnFailure: z.boolean().nullable(),
    maxRetries: z.number().int().nullable(),
    globalTimeout: z.number().int().nullable(),
    matrixValues: z.array(z.string()).nullable(),
    extraMatrix: z.array(z.object({ key: z.string(), values: z.array(z.string()) })).nullable(),
    extraEnv: z.array(z.object({ name: z.string(), value: z.string() })).nullable(),
    extraPre: z.array(z.string()).nullable(),
    post: z.array(z.string()).nullable(),
    runnerCommand: z.string().nullable(),
    discoveryCommand: z.string().nullable(),
    discoveryMode: z.enum(["local", "remote"]).nullable(),
    runnerClass: z.string().nullable(),
    groups: z.string().nullable(),
    flags: z.array(z.string()).nullable(),
    tunnel: z.boolean().nullable(),
    jobLabel: z.array(z.string()).nullable(),
  }).describe("Only set fields that should change; null = keep current value."),
  resetOptions: z.array(z.string()).describe("Option names to clear back to default."),
  yaml: z.string().nullable().describe("Full replacement YAML, only when action is replace_yaml."),
});
const { $schema, ...PLAN_JSON_SCHEMA } = z.toJSONSchema(PlanSchema); // the claude CLI rejects the draft-2020-12 $schema header

const SYSTEM = `You are the HyperExecute YAML assistant inside VS Code, helping a LambdaTest solution engineer build a HyperExecute YAML for a customer's test-automation repo.

You receive: the repo analysis, the current generator options, the current YAML, its validation result, and knowledge-base excerpts (bundled notes and the team's Confluence space HYP — Confluence wins when they conflict).

Decide one action:
- update_options (preferred): express the request as generator option changes. A deterministic generator then rebuilds the YAML, so the output stays valid. Set only the fields that change; null means keep.
- replace_yaml: only when options cannot express it (e.g. failFast, retryOptions, background services, hostsOverride, custom uploadArtefacts, dataJsonPath). Return the COMPLETE YAML, based on the current YAML.
- answer_only: questions/explanations with no change.

Rules:
- runson values: linux, mac, mac13, win, win11 (never "windows").
- YAML v0.2 (framework: block) exists for maven|gradle testng/junit4/junit5/spock and dotnet nunit/mstest. It does not support matrix, tag/file/feature/scenario splitting or custom commands — switch yamlVersion to "0.1" when the user asks for those. A v0.2 YAML must never contain testDiscovery.
- Cross-browser / cross-device requests: extraMatrix axes (tests read them as env vars) — this needs matrix mode (v0.1).
- Never inline secrets; use \${{ .secrets.NAME }}.
- Tag lists (e.g. @smoke, regression) go in matrixValues with splitBy "tag".
- "Optimize" requests: use CONTEXT.optimizerSuggestions — apply them via options where possible (splitBy, yamlVersion, concurrency, retries) or replace_yaml for the rest; mention what you applied.
- Questions about credentials or customer reporting: answer from CONTEXT.repoScan and point to the Setup tab, where hard-coded credentials can be replaced with env vars.
- Keep "reply" to 1-4 sentences, plain text. Mention the Confluence page title when you relied on it. If the request is ambiguous, pick the sensible default and say what you assumed.`;

// ---------- backends ----------

function findClaude(configured) {
  const onPath = (process.env.PATH || "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, process.platform === "win32" ? "claude.exe" : "claude"));
  const candidates = [configured, path.join(os.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", path.join(os.homedir(), ".claude/local/claude"), ...onPath].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

function runClaudeCli(bin, prompt, model, token) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--no-session-persistence", "--tools", "", "--system-prompt", SYSTEM, "--json-schema", JSON.stringify(PLAN_JSON_SCHEMA)];
    if (model) args.push("--model", model);
    const child = spawn(bin, args, { cwd: os.tmpdir(), env: process.env });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    token?.onCancellationRequested(() => child.kill());
    const timer = setTimeout(() => child.kill(), 180000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(out);
        if (res.is_error) return reject(new Error(res.result || "claude CLI returned an error"));
        if (res.structured_output) return resolve(res.structured_output);
        return resolve(extractJson(res.result));
      } catch (e) {
        reject(new Error(`claude CLI failed (exit ${code}): ${(err || out).slice(0, 400)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

async function runVscodeLm(prompt, token) {
  const models = await vscode.lm.selectChatModels();
  if (!models.length) throw new Error("No VS Code language models available (install GitHub Copilot or another provider).");
  const model = models.find((m) => /claude/i.test(m.family)) || models[0];
  const res = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(`${SYSTEM}\n\nRespond with ONLY a JSON object matching this schema:\n${JSON.stringify(PLAN_JSON_SCHEMA)}\n\n${prompt}`)],
    { justification: "Generate a HyperExecute YAML from your request" },
    token
  );
  let text = "";
  for await (const part of res.text) text += part;
  return extractJson(text);
}

async function runAnthropicApi(apiKey, prompt) {
  const Anthropic = require("@anthropic-ai/sdk");
  const { betaZodOutputFormat } = require("@anthropic-ai/sdk/helpers/beta/zod");
  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: betaZodOutputFormat(PlanSchema) },
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  if (!response.parsed_output) throw new Error("Could not parse the model's response.");
  return response.parsed_output;
}

function extractJson(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Model did not return JSON.");
  return PlanSchema.parse(JSON.parse(s.slice(start, end + 1)));
}

// ---------- offline rules ----------

function emptyOptions() {
  return Object.fromEntries(Object.keys(PlanSchema.shape.options.shape).map((k) => [k, null]));
}

function rulesPlan(text) {
  const t = text.toLowerCase();
  const o = emptyOptions();
  const done = [];
  if (/\bwin(dows)?\s*11\b/.test(t)) (o.runson = "win11"), done.push("OS → win11");
  else if (/\bwin(dows)?\b/.test(t)) (o.runson = "win"), done.push("OS → win");
  else if (/\bmac(os)?\b/.test(t)) (o.runson = "mac"), done.push("OS → mac");
  else if (/\blinux|ubuntu\b/.test(t)) (o.runson = "linux"), done.push("OS → linux");
  const conc = t.match(/(\d+)\s*(vms?|machines|parallel|concurren|nodes|workers)/) || t.match(/concurrency\s*(?:of|to|=|:)?\s*(\d+)/);
  if (conc) (o.concurrency = +conc[1]), done.push(`concurrency → ${conc[1]}`);
  const split = t.match(/(?:split|shard|distribute)\w*\s+(?:by|on|per)\s+(class|method|suite|file|feature|scenario|tag)/) || t.match(/\bper\s+(class|method|suite|file|feature|scenario|tag)/);
  if (split) (o.splitBy = split[1]), done.push(`split → ${split[1]}`);
  if (/v?0\.2|framework (field|mode)|native discovery/.test(t)) (o.yamlVersion = "0.2"), done.push("YAML v0.2");
  else if (/v?0\.1|raw discovery/.test(t)) (o.yamlVersion = "0.1"), done.push("YAML v0.1");
  if (/\bmatrix\b/.test(t)) (o.executionMode = "matrix"), done.push("matrix mode");
  if (/\bautosplit\b/.test(t)) (o.executionMode = "autosplit"), done.push("autosplit mode");
  if (/\btunnel\b/.test(t)) (o.tunnel = !/(no|without|disable|remove)\s+tunnel/.test(t)), done.push(`tunnel ${o.tunnel ? "on" : "off"}`);
  const retries = t.match(/(\d)\s*retr/) || t.match(/retr\w*\s*(?:to|=|:)?\s*(\d)/);
  if (retries) (o.maxRetries = +retries[1]), (o.retryOnFailure = +retries[1] > 0), done.push(`retries → ${retries[1]}`);
  if (/no retr|disable retr/.test(t)) (o.retryOnFailure = false), done.push("retries off");
  const timeout = t.match(/timeout\s*(?:of|to|=|:)?\s*(\d+)/);
  if (timeout) (o.globalTimeout = Math.min(150, +timeout[1])), done.push(`timeout → ${o.globalTimeout} min`);
  const browsers = ["chrome", "firefox", "edge", "safari", "webkit", "chromium"].filter((b) => t.includes(b));
  if (browsers.length > 1) (o.extraMatrix = [{ key: "browser", values: browsers }]), (o.executionMode = "matrix"), (o.yamlVersion = "0.1"), done.push(`browser matrix: ${browsers.join(", ")}`);
  const tags = text.match(/@[\w-]+/g);
  if (tags && /tag/.test(t)) (o.matrixValues = tags), (o.splitBy = "tag"), (o.yamlVersion = "0.1"), done.push(`tags: ${tags.join(", ")}`);
  const oses = OS.filter((x) => new RegExp(`\\b${x}\\b`).test(t));
  if (/(both|across|multi|all)\s.*(os|platform)|linux and win|win and linux|mac and win/.test(t) && oses.length > 1) (o.runsonMatrix = oses), (o.executionMode = "matrix"), (o.yamlVersion = "0.1"), done.push(`multi-OS: ${oses.join(", ")}`);
  return {
    reply: done.length
      ? `Applied: ${done.join(" · ")}. (Offline rules mode — connect an AI backend for free-form requests.)`
      : "I couldn't map that to a change in offline rules mode. Try e.g. \"run on windows with 10 VMs\", \"split by scenario\", \"add tunnel\", \"chrome and firefox\", \"tags @smoke @regression\" — or configure an AI backend (HyperExecute: Choose AI Backend).",
    action: done.length ? "update_options" : "answer_only",
    options: o,
    resetOptions: [],
    yaml: null,
  };
}

// ---------- entry ----------

async function detectBackend(context) {
  const cfg = vscode.workspace.getConfiguration("hyperexecute");
  const pref = cfg.get("aiBackend", "auto");
  const claudeBin = findClaude(cfg.get("claudePath"));
  const apiKey = (await context.secrets.get("hyperexecute.anthropicKey")) || process.env.ANTHROPIC_API_KEY;
  let lmCount = 0;
  try { lmCount = (await vscode.lm.selectChatModels()).length; } catch {}
  const available = { "claude-cli": !!claudeBin, "vscode-lm": lmCount > 0, "anthropic-api": !!apiKey, rules: true };
  const name = pref !== "auto" ? pref : ["claude-cli", "vscode-lm", "anthropic-api", "rules"].find((b) => available[b]);
  return { name, available, claudeBin, apiKey, model: cfg.get("claudeModel") || null };
}

const LABELS = { "claude-cli": "Claude Code CLI", "vscode-lm": "VS Code language model", "anthropic-api": "Anthropic API (Claude Opus 5.5)", rules: "Offline rules" };

async function plan(context, promptContext, userText, token) {
  const backend = await detectBackend(context);
  const prompt = `CONTEXT (JSON):\n${JSON.stringify(promptContext)}\n\nUSER REQUEST:\n${userText}`;
  let result;
  switch (backend.name) {
    case "claude-cli":
      if (!backend.claudeBin) throw new Error("claude CLI not found — set hyperexecute.claudePath.");
      result = await runClaudeCli(backend.claudeBin, prompt, backend.model, token);
      break;
    case "vscode-lm":
      result = await runVscodeLm(prompt, token);
      break;
    case "anthropic-api":
      if (!backend.apiKey) throw new Error("No Anthropic API key — run \"HyperExecute: Set Anthropic API Key\".");
      result = await runAnthropicApi(backend.apiKey, prompt);
      break;
    default:
      result = rulesPlan(userText);
  }
  return { plan: PlanSchema.parse(result), backend: LABELS[backend.name] || backend.name };
}

module.exports = { plan, detectBackend, rulesPlan, LABELS };
