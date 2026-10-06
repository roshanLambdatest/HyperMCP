// Puts validateYaml's messages on lines of the file, and offers the fixes that are safe to make
// by editing text: used by the VS Code extension for squiggles, the Problems panel and quick fixes.

import { explainYamlLines } from "./yaml-explain.js";

const TABS = /tab indentation|\btabs? (are|is) not allowed/i;
const keyLines = (text) =>
  explainYamlLines(text)
    .filter((l) => l.kind === "key" && l.path)
    .map((l) => ({ n: l.n, path: l.path.replace(/\[\]/g, ""), text: l.text }));

// The 1-based line a validation message is about; the first key line when it names no key.
export function locateYamlMessage(text, message) {
  const lines = String(text ?? "").split("\n");
  const msg = String(message ?? "");
  const at = msg.match(/at line (\d+)/);
  if (at) return Math.min(+at[1], lines.length);
  if (TABS.test(msg)) return Math.max(1, lines.findIndex((l) => /^\t/.test(l)) + 1);
  const keys = keyLines(text);
  // names in the message, most specific first: `a.b`, "key", or a leading a.b path
  const named = [
    ...[...msg.matchAll(/`([A-Za-z][\w.]*)`/g)].map((m) => m[1]),
    ...[...msg.matchAll(/key "([\w.-]+)"/g)].map((m) => m[1]),
    ...[...msg.matchAll(/\b([a-z][A-Za-z]*(?:\.[A-Za-z_][\w]*)+)\b/g)].map((m) => m[1]),
    (msg.match(/^([a-z][A-Za-z]+)\b/) || [])[1],
  ].filter(Boolean).sort((a, b) => b.split(".").length - a.split(".").length);
  for (const name of named) {
    const hit = keys.find((k) => k.path === name) || keys.find((k) => k.path.endsWith(`.${name}`));
    if (hit) return hit.n;
  }
  // a top-level key of this file named in plain words ("must NOT contain testDiscovery"): the first one mentioned
  const plain = keys
    .filter((k) => !k.path.includes("."))
    .map((k) => ({ k, at: msg.search(new RegExp(`\\b${k.path}\\b`)) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  if (plain) return plain.k.n;
  return keys[0]?.n || 1;
}

const RUNSON_FIX = { windows: "win", windows10: "win", windows11: "win11", ubuntu: "linux", macos: "mac", osx: "mac", darwin: "mac" };

// Text edits that fix a message, when the fix is certain: [{ title, edits: [{ line, text } | { line, insert } | { from, to, remove: true }] }]
// line/from/to are 1-based; "text" replaces the line, "insert" adds a line above it.
export function yamlMessageFixes(text, message) {
  const lines = String(text ?? "").split("\n");
  const msg = String(message ?? "");
  const n = locateYamlMessage(text, msg);
  const line = lines[n - 1] ?? "";
  const indent = line.match(/^\s*/)[0];
  const fixes = [];
  const unknown = msg.match(/Unknown top-level key "([^"]+)" — did you mean "([^"]+)"\?/);
  if (unknown && line.trimStart().startsWith(`${unknown[1]}:`)) fixes.push({ title: `Rename to ${unknown[2]}`, edits: [{ line: n, text: line.replace(`${unknown[1]}:`, `${unknown[2]}:`) }] });
  if (/`maxRetries` is set but `retryOnFailure` is not true/.test(msg)) {
    const existing = lines.findIndex((l) => /^\s*retryOnFailure:/.test(l));
    fixes.push({ title: "Set retryOnFailure: true", edits: [existing >= 0 ? { line: existing + 1, text: lines[existing].replace(/retryOnFailure:.*/, "retryOnFailure: true") } : { line: n, insert: `${indent}retryOnFailure: true` }] });
  }
  if (/v0\.2 YAML must NOT contain testDiscovery/.test(msg)) {
    const from = lines.findIndex((l) => /^testDiscovery:/.test(l));
    if (from >= 0) {
      let to = from + 1;
      while (to < lines.length && (/^\s/.test(lines[to]) || lines[to] === "")) to++;
      fixes.push({ title: "Remove testDiscovery (v0.2 finds the tests itself)", edits: [{ from: from + 1, to, remove: true }] });
    }
  }
  if (TABS.test(msg)) {
    const edits = lines.map((l, i) => (/^\t/.test(l) ? { line: i + 1, text: l.replace(/^\t+/, (t) => "  ".repeat(t.length)) } : null)).filter(Boolean);
    if (edits.length) fixes.push({ title: "Replace tab indentation with spaces", edits });
  }
  const runson = msg.match(/runson "([^"]+)" is invalid/);
  const to = runson && RUNSON_FIX[runson[1].toLowerCase().replace(/[\s_-]/g, "")];
  if (to) fixes.push({ title: `Change runson to ${to}`, edits: [{ line: n, text: line.replace(/(runson:\s*)(["']?)[^"'\s#]+\2/, `$1${to}`) }] });
  return fixes;
}
