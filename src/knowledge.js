// Local knowledge base: every .md file in ./knowledge (and HE_KB_DIR, if set) is indexed by "## " sections;
// .yaml/.yml/.txt files (e.g. knowledge/golden/*.yaml) are indexed whole.
// Confluence pages that were read once are cached in ~/.hyperexecute-studio/kb-cache and searched offline too,
// as are GitHub gists synced with HE_GISTS (kb-cache/gists, see gists.js) and TestMu AI docs pages read
// as a fallback (kb-cache/docs, see docs.js).
// Search is BM25 with light stemming and HyperExecute synonyms, so "tests not found" also finds "0 tests discovered".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const KB_CACHE_DIR = process.env.HE_KB_CACHE_DIR || path.join(os.homedir(), ".hyperexecute-studio", "kb-cache");
export const KB_DIRS = [path.join(here, "..", "knowledge"), process.env.HE_KB_DIR, KB_CACHE_DIR].filter(Boolean);

function mdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return mdFiles(p);
    return /\.(md|ya?ml|txt)$/.test(e.name) ? [p] : [];
  });
}

// A protected build embeds the bundled knowledge as data (globalThis.__HE_KB_FILES__ = [{ path, text }])
// instead of shipping readable files; HE_KB_DIR and the Confluence cache are still read from disk.
const EMBEDDED = () => globalThis.__HE_KB_FILES__;
function kbFiles() {
  const out = [];
  for (const dir of KB_DIRS) {
    const cacheSource = (rel) => (rel.startsWith("gists/") ? "gist" : rel.startsWith("docs/") ? "testmu-docs" : "confluence-cache");
    const source = dir === KB_CACHE_DIR ? null : "local";
    if (dir === KB_DIRS[0] && EMBEDDED()) {
      for (const f of EMBEDDED()) out.push({ source, rel: f.path, file: f.path, text: f.text });
      continue;
    }
    for (const file of mdFiles(dir)) {
      const rel = path.relative(dir, file).split(path.sep).join("/");
      out.push({ source: source || cacheSource(rel), rel, file, text: fs.readFileSync(file, "utf8") });
    }
  }
  return out;
}

export function loadKnowledge() {
  const docs = [];
  {
    for (const { source, rel, file, text } of kbFiles()) {
      const topic = rel.replace(/\.(md|ya?ml|txt)$/, "");
      if (!file.endsWith(".md")) {
        // golden YAMLs: the leading comment block describes the case
        const about = text.match(/^(?:#.*\n)+/)?.[0].replace(/^#\s?/gm, "").trim();
        docs.push({ topic, section: about?.split("\n")[0] || path.basename(file), text, source });
        continue;
      }
      const parts = text.split(/^(?=## )/m);
      for (const part of parts) {
        const heading = (part.match(/^##\s+(.+)/) || [])[1] || (part.match(/^#\s+(.+)/m) || [])[1] || topic;
        docs.push({ topic, section: heading.trim(), text: part.trim(), source });
      }
    }
  }
  return docs;
}

export function listTopics() {
  const docs = loadKnowledge();
  const topics = {};
  for (const d of docs) (topics[d.topic] ||= []).push(d.section);
  return topics;
}

// ---------- search ----------

const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "are", "be", "it", "how", "do", "does", "i", "my", "with", "what", "why", "when", "can", "this", "that", "use", "using"]);

// Words that mean the same thing in HyperExecute questions. Each group is expanded at half weight.
const SYNONYMS = [
  ["discovery", "discover", "detect", "find", "found", "collect", "testdiscovery"],
  ["zero", "0", "none", "empty", "nothing"],
  ["runson", "os", "platform", "linux", "win", "windows", "mac", "macos"],
  ["concurrency", "parallel", "parallelism", "worker", "vm", "shard", "thread"],
  ["retry", "rerun", "flaky", "retryonfailure", "maxretries"],
  ["timeout", "hang", "stuck", "globaltimeout", "testsuitetimeout", "idletimeout"],
  ["secret", "credential", "password", "token", "key", "accesskey", "username"],
  ["report", "partialreports", "artefact", "artifact", "uploadartefacts", "mergeartifacts"],
  ["cache", "cachekey", "cachedirectories", "caching"],
  ["tunnel", "private", "internal", "localhost", "vpn", "firewall", "staging"],
  ["tag", "group", "marker", "category", "label", "grep"],
  ["split", "autosplit", "matrix", "distribute"],
  ["install", "dependency", "pre", "dep", "package", "requirement"],
  ["fail", "error", "failure", "broken", "exception"],
  ["java", "maven", "gradle", "mvn", "testng", "junit"],
  ["python", "pytest", "pip", "behave", "robot"],
  ["node", "npm", "javascript", "typescript", "playwright", "cypress", "wdio", "webdriverio"],
  ["dotnet", "csharp", "nunit", "mstest", "xunit", "specflow"],
  ["v0.2", "0.2", "framework", "native"],
];

function stem(w) {
  if (w.length <= 4 || /[^a-z]/.test(w)) return w;
  return w.replace(/(ies)$/, "y").replace(/(ing|ed|es|s)$/, "");
}

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_.#-]+/)
    .map((t) => t.replace(/^[.#-]+|[.#-]+$/g, ""))
    .filter((t) => t.length > 0 && !STOP.has(t))
    .map(stem);
}

const SYN_INDEX = new Map();
for (const g of SYNONYMS) for (const w of g) SYN_INDEX.set(stem(w), g.map(stem));

function expand(terms) {
  const out = new Map();
  for (const t of terms) out.set(t, Math.max(out.get(t) || 0, 1));
  for (const t of terms) for (const s of SYN_INDEX.get(t) || []) if (!out.has(s)) out.set(s, 0.5);
  return out;
}

export function searchKnowledge(query, limit = 6) {
  const docs = loadKnowledge();
  const q = expand(tokenize(query));
  if (!q.size) return [];
  const index = docs.map((d) => {
    const toks = tokenize(d.text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { d, len: toks.length || 1, tf, head: new Set(tokenize(`${d.topic} ${d.section}`)) };
  });
  const N = index.length;
  const avg = index.reduce((n, x) => n + x.len, 0) / (N || 1);
  const df = new Map();
  for (const [t] of q) df.set(t, index.filter((x) => x.tf.has(t) || x.head.has(t)).length);
  const k1 = 1.2;
  const b = 0.75;
  return index
    .map((x) => {
      let score = 0;
      let exact = 0;
      for (const [t, w] of q) {
        const n = df.get(t);
        if (!n) continue;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        const f = x.tf.get(t) || 0;
        score += w * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * x.len) / avg)));
        if (x.head.has(t)) score += w * idf * 1.5; // heading/topic matches count extra
        if (w === 1 && (f || x.head.has(t))) exact++;
      }
      return { ...x.d, score: Math.round(score * 100) / 100, matchedTerms: exact };
    })
    .filter((x) => x.score > 0)
    .sort((a, b2) => b2.matchedTerms - a.matchedTerms || b2.score - a.score)
    .slice(0, limit);
}

export function getTopic(topic) {
  const hit = kbFiles().find((f) => f.rel.replace(/\.(md|ya?ml|txt)$/, "") === topic);
  if (hit) return hit.text;
  for (const dir of KB_DIRS) {
    for (const ext of [".md", ".yaml", ".yml", ".txt"]) {
      const p = path.join(dir, topic + ext);
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    }
  }
  return null;
}

// Saves a Confluence page so later searches work offline (and without Atlassian credentials).
export function cacheConfluencePage(page) {
  try {
    const dir = path.join(KB_CACHE_DIR, "confluence");
    fs.mkdirSync(dir, { recursive: true });
    const slug = String(page.title || page.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    const body = `# ${page.title}\n\nSource: ${page.url} (Confluence ${page.space || ""}, version ${page.version ?? "?"}, cached ${new Date().toISOString().slice(0, 10)})\n\n${String(page.content).replace(/^# /gm, "## ")}\n`;
    const file = path.join(dir, `${page.id}-${slug}.md`);
    for (const f of fs.readdirSync(dir)) if (f.startsWith(`${page.id}-`) && f !== path.basename(file)) fs.rmSync(path.join(dir, f));
    fs.writeFileSync(file, body);
    return file;
  } catch {
    return null;
  }
}

export function cacheStatus() {
  const dir = path.join(KB_CACHE_DIR, "confluence");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
  return { dir, pages: files.length };
}
