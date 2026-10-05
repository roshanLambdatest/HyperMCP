// Optional: answer free-form chat with Claude, using the visitor's own Anthropic API key.
// The key stays in this tab (memory only). Sent to Anthropic: the question, the chat so far, the current
// YAML and a summary of the repo (framework, counts, options, check results) — never the source files.
// Claude returns a plan in the same shape as the built-in assistant, so the same code applies it.

import Anthropic from "@anthropic-ai/sdk";
import { betaJSONSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/beta/json-schema";

const OS = ["linux", "mac", "mac13", "win", "win11"];
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const str = { type: "string" };

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "action", "options", "yaml", "explanations"],
  properties: {
    reply: { type: "string", description: "Answer to the user in 1-5 short sentences or a short list. Plain words; `code` for keys and commands." },
    action: { type: "string", enum: ["update_options", "replace_yaml", "answer_only"] },
    options: {
      type: "object",
      additionalProperties: false,
      description: "Generator option changes. null = keep the current value.",
      required: ["yamlVersion", "runson", "runsonMatrix", "executionMode", "splitBy", "concurrency", "retryOnFailure", "maxRetries", "globalTimeout", "matrixValues", "extraMatrix", "extraEnv", "extraPre", "tunnel", "mavenProfile"],
      properties: {
        yamlVersion: nullable({ type: "string", enum: ["0.1", "0.2"] }),
        runson: nullable({ type: "string", enum: OS }),
        runsonMatrix: nullable({ type: "array", items: { type: "string", enum: OS } }),
        executionMode: nullable({ type: "string", enum: ["autosplit", "matrix"] }),
        splitBy: nullable({ type: "string", enum: ["class", "method", "suite", "file", "feature", "scenario", "tag", "none"] }),
        concurrency: nullable({ type: "integer" }),
        retryOnFailure: nullable({ type: "boolean" }),
        maxRetries: nullable({ type: "integer" }),
        globalTimeout: nullable({ type: "integer" }),
        matrixValues: nullable({ type: "array", items: str }),
        extraMatrix: nullable({ type: "array", items: { type: "object", additionalProperties: false, required: ["key", "values"], properties: { key: str, values: { type: "array", items: str } } } }),
        extraEnv: nullable({ type: "array", items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: str, value: str } } }),
        extraPre: nullable({ type: "array", items: str }),
        tunnel: nullable({ type: "boolean" }),
        mavenProfile: nullable(str),
      },
    },
    yaml: nullable({ type: "string", description: "The COMPLETE replacement YAML, only when action is replace_yaml." }),
    explanations: {
      type: "array",
      description: "One entry per changed option (or YAML key for replace_yaml): why it matters on HyperExecute, one sentence. Empty for answer_only.",
      items: { type: "object", additionalProperties: false, required: ["key", "why"], properties: { key: str, why: str } },
    },
  },
};

const SYSTEM = `You are the assistant inside HyperExecute Studio, a web page where a LambdaTest customer turns their test-automation repo into a HyperExecute YAML. You talk to the customer directly.

You receive a summary of their repo (never the source files), the current generator options, the current YAML and its check results.

Pick one action:
- update_options (preferred): express the request as generator option changes; a deterministic generator rebuilds the YAML so it stays valid. Set only the fields that change; null keeps the current value.
- replace_yaml: only when options can't express it (for example failFast, retryOptions, background services, hostsOverride, custom uploadArtefacts). Return the complete YAML, based on the current one.
- answer_only: questions and explanations.

Rules:
- runson values are linux, mac, mac13, win, win11.
- YAML v0.2 (the framework: block) exists only for Maven/Gradle TestNG, JUnit 4/5, Spock and .NET NUnit/MSTest. It has no matrix mode, no tag/file/feature/scenario splitting and no custom commands: switch yamlVersion to "0.1" for those. A v0.2 YAML must never contain testDiscovery.
- Cross-browser or cross-device runs use extraMatrix axes (the tests read them as environment variables) in matrix mode, v0.1.
- Tags go in matrixValues with splitBy "tag".
- Never put a secret value in the YAML yourself; use \${{ .secrets.NAME }} references.
- If a request is ambiguous, take the sensible default and say what you assumed. Don't invent HyperExecute keys; if you're not sure a key exists, say so.
- explanations: for every option or YAML key you change, one plain sentence on what it does on HyperExecute and why it fits their request, so they learn the YAML. Use the option name as key (or the YAML key for replace_yaml).
- CONTEXT.activity lists what the customer did on the page (analysis, option-bar changes, downloads); use it when they ask what changed.
- Keep "reply" short and specific to their repo.`;

export async function askClaude({ apiKey, context, history, text }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const messages = [
    ...history.slice(-8).map((m) => ({ role: m.role, content: m.text })),
    { role: "user", content: `CONTEXT (JSON):\n${JSON.stringify(context)}\n\nREQUEST:\n${text}` },
  ];
  // the API needs the first message to be the user's and roles to alternate from there
  while (messages.length && messages[0].role !== "user") messages.shift();
  const response = await client.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages,
    output_config: { effort: "low", format: betaJSONSchemaOutputFormat(PLAN_SCHEMA) },
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined this request.");
  if (!response.parsed_output) throw new Error("Claude's answer couldn't be read. Try rephrasing.");
  return toPlan(response.parsed_output);
}

// Claude's arrays of {key, values} / {name, value} → the generator's objects; nulls dropped.
function toPlan(p) {
  const options = {};
  for (const [k, v] of Object.entries(p.options || {})) {
    if (v === null) continue;
    if (k === "extraMatrix") options.extraMatrix = Object.fromEntries(v.map((x) => [x.key, x.values]));
    else if (k === "extraEnv") options.extraEnv = Object.fromEntries(v.map((x) => [x.name, x.value]));
    else options[k] = v;
  }
  const explanations = p.explanations || [];
  if (p.action === "replace_yaml" && p.yaml) return { reply: p.reply, yaml: p.yaml, explanations };
  if (p.action === "update_options" && Object.keys(options).length) return { reply: p.reply, options, explanations };
  return { reply: p.reply };
}

export async function checkKey(apiKey) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  await client.models.retrieve("claude-opus-5-5");
}
