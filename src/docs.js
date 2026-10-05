// Fallback to the public TestMu AI (LambdaTest) docs, https://www.testmuai.com/support/docs, when the knowledge
// base has no good answer. Pages are found with the site's own search (its public, search-only settings are
// read from the docs page, as a browser does) or, if that fails, by matching the sitemap's 1,300+ page
// addresses. They are fetched, turned into Markdown and cached in the knowledge cache (kb-cache/docs), so
// later searches find them locally too. HE_DOCS=off turns it off.

import fs from "node:fs";
import path from "node:path";
import { KB_CACHE_DIR, tokenize } from "./knowledge.js";

const SITE = process.env.HE_DOCS_SITE || "https://www.testmuai.com"; // overridable for tests
const SITEMAP = `${SITE}/support/sitemap.xml`;
const DOCS_PREFIX = `${SITE}/support/docs/`;
const MAX_AGE = 7 * 864e5; // sitemap and pages are refreshed weekly
const UA = "hyperexecute-studio (docs lookup)";

export const docsEnabled = () => !/^(off|0|false|no)$/i.test(process.env.HE_DOCS || "");
export const docsDir = () => path.join(KB_CACHE_DIR, "docs");

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xml" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`TestMu AI docs ${res.status}: ${url}`);
  return res.text();
}

const fresh = (file) => { try { return Date.now() - fs.statSync(file).mtimeMs < MAX_AGE; } catch { return false; } };

async function docUrls() {
  const file = path.join(docsDir(), "sitemap.json");
  if (fresh(file)) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch {} }
  const xml = await get(SITEMAP);
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()).filter((u) => u.startsWith(DOCS_PREFIX));
  fs.mkdirSync(docsDir(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(urls));
  return urls;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/" };
const decode = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => ENTITIES[e] ?? (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : m));
const strip = (s) => decode(s.replace(/<[^>]+>/g, ""));

// The article of a Docusaurus page as Markdown: headings, paragraphs, lists, code blocks with their language.
export function docToMarkdown(html) {
  const title = strip((html.match(/<title[^>]*>([^<]*)<\/title>/) || [])[1] || "").replace(/\s*\|\s*TestMu AI.*$/, "").trim();
  let body = (html.match(/<div class="theme-doc-markdown markdown">([\s\S]*?)<\/article>/) || html.match(/<article[^>]*>([\s\S]*?)<\/article>/) || [])[1] || "";
  const code = [];
  body = body.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/g, "").replace(/<nav[^>]*>[\s\S]*?<\/nav>/g, "");
  body = body.replace(/<pre[^>]*class="[^"]*language-([\w-]+)[^"]*"[^>]*>([\s\S]*?)<\/pre>|<pre[^>]*>([\s\S]*?)<\/pre>/g, (_, lang, a, b) => {
    const text = strip((a ?? b).replace(/<br\s*\/?>/g, "\n")).replace(/\n{3,}/g, "\n\n").trimEnd();
    code.push("```" + (lang || "") + "\n" + text + "\n```");
    return `\n\n\u0000${code.length - 1}\u0000\n\n`;
  });
  body = body
    .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/g, (_, n, t) => `\n\n${"#".repeat(Math.max(2, +n))} ${strip(t).replace(/​/g, "").trim()}\n\n`)
    .replace(/<li[^>]*>/g, "\n- ")
    .replace(/<(br)\s*\/?>/g, "\n")
    .replace(/<\/(p|div|ul|ol|table|tr|blockquote)>/g, "\n\n")
    .replace(/<\/t[dh]>/g, " | ")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/g, (_, t) => "`" + strip(t) + "`");
  let text = strip(body).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => code[+i]);
  return { title, markdown: text.slice(0, 40000) };
}

// The docs site's search settings (Typesense DocSearch), read from its own page and kept for a week.
async function siteSearchConfig() {
  const file = path.join(docsDir(), "search.json");
  if (fresh(file)) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch {} }
  const html = await get(`${SITE}/support/docs/`);
  const main = (html.match(/src="(\/support\/assets\/js\/main\.[\w]+\.js)"/) || [])[1];
  if (!main) throw new Error("docs search settings not found");
  const js = await get(SITE + main);
  const m = js.match(/typesenseCollectionName:"([\w-]+)"[\s\S]{0,200}?host:"([\w.-]+)"[\s\S]{0,100}?apiKey:"(\w+)"/);
  if (!m) throw new Error("docs search settings not found");
  const cfg = { collection: m[1], host: m[2], key: m[3] };
  fs.mkdirSync(docsDir(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg));
  return cfg;
}

// Question words and filler that only blur a keyword search
const FILLER = new Set("a an the to of in on for with and or is are was be do does did can could should would how what why when where which who i we you my our your it this that there use using set get make need want please help me about".split(" "));
export const keywords = (q) => String(q).split(/\s+/).filter((w) => w && !FILLER.has(w.toLowerCase().replace(/[?.,!:;]+$/, ""))).join(" ") || String(q);

async function siteSearch(query, limit) {
  const cfg = await siteSearchConfig();
  query = keywords(query);
  const u = new URL(`https://${cfg.host}/collections/${encodeURIComponent(cfg.collection)}/documents/search`);
  for (const [k, v] of Object.entries({ q: query, query_by: "hierarchy.lvl0,hierarchy.lvl1,hierarchy.lvl2,content", group_by: "url_without_anchor", group_limit: "1", per_page: String(limit * 2) })) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { "X-TYPESENSE-API-KEY": cfg.key }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) fs.rmSync(path.join(docsDir(), "search.json"), { force: true }); // settings changed: read them again next time
    throw new Error(`docs search ${res.status}`);
  }
  const j = await res.json();
  return [...new Set((j.grouped_hits || []).map((g) => g.hits?.[0]?.document?.url_without_anchor).filter((x) => x?.startsWith(DOCS_PREFIX)))];
}

// Which doc pages fit the question (fallback): words from the URL path, rare words counting more (as in search
// engines: "smartui" says more about a page than "hyperexecute", which 200 pages share).
function rankUrls(urls, query) {
  const q = [...new Set(tokenize(keywords(query)))];
  if (!q.length) return [];
  const docs = urls.map((u) => ({ u, words: new Set(tokenize(u.slice(DOCS_PREFIX.length).replace(/[/_.-]+/g, " ").replace(/(\d)/g, " $1"))) }));
  const idf = new Map(q.map((t) => [t, Math.log(1 + docs.length / (1 + docs.filter((d) => d.words.has(t)).length))]));
  return docs
    .map(({ u, words }) => {
      const hits = q.filter((t) => words.has(t));
      // all words matched beats most; then rarer words; then shorter (more specific) pages
      return { u, hits: hits.length, score: hits.reduce((n, t) => n + idf.get(t), 0) - words.size * 0.01 };
    })
    .filter((x) => x.hits >= Math.min(2, q.length)) // one shared word is not a match
    .sort((a, b) => b.score - a.score)
    .map((x) => x.u);
}

async function page(url) {
  const slug = url.slice(DOCS_PREFIX.length).replace(/\/$/, "").replace(/[^\w-]+/g, "_").slice(0, 100) || "index";
  const file = path.join(docsDir(), `${slug}.md`);
  if (fresh(file)) {
    const text = fs.readFileSync(file, "utf8");
    return { title: (text.match(/^# (.+)/) || [])[1] || slug, url, markdown: text.replace(/^# .+\n\nSource: .+\n\n/, "") };
  }
  const { title, markdown } = docToMarkdown(await get(url));
  if (!markdown) return null;
  fs.mkdirSync(docsDir(), { recursive: true });
  fs.writeFileSync(file, `# ${title}\n\nSource: ${url} (TestMu AI docs, cached ${new Date().toISOString().slice(0, 10)})\n\n${markdown}\n`);
  return { title, url, markdown };
}

// The parts of a page that mention the question's words, up to `max` characters.
function excerpt(markdown, query, max = 2500) {
  const q = new Set(tokenize(query));
  const parts = markdown.split(/\n(?=## )/);
  const scored = parts.map((p, i) => ({ p, i, n: tokenize(p).filter((t) => q.has(t)).length })).filter((x) => x.n);
  const pick = (scored.length ? scored.sort((a, b) => b.n - a.n) : [{ p: parts[0], i: 0 }]).slice(0, 3).sort((a, b) => a.i - b.i);
  return pick.map((x) => x.p.trim()).join("\n\n").slice(0, max);
}

export async function searchDocs(query, { limit = 3 } = {}) {
  if (!docsEnabled()) return { off: true, results: [] };
  // both finders, alternating: the site's search reads page text, the address match catches pages whose
  // title says it all ("how-to-find-correct-concurrency") but which the search ranks low
  const [site, mapped] = await Promise.all([siteSearch(query, limit).catch(() => []), docUrls().then((u) => rankUrls(u, query)).catch(() => [])]);
  const urls = [];
  for (let i = 0; urls.length < limit && (i < site.length || i < mapped.length); i++) for (const u of [site[i], mapped[i]]) if (u && !urls.includes(u) && urls.length < limit) urls.push(u);
  const via = site.length && mapped.length ? "site search + sitemap" : site.length ? "site search" : "sitemap";
  const results = [];
  for (const u of urls) {
    try {
      const p = await page(u);
      if (p) results.push({ title: p.title, url: p.url, text: excerpt(p.markdown, query) });
    } catch (e) {
      results.push({ url: u, error: e.message });
    }
  }
  return { site: `${SITE}/support/docs`, via, results };
}

// Local knowledge answers well when its best hit holds most of the question's specific words. Words every
// note shares ("hyperexecute", "yaml", "test") say nothing about whether this note is the answer.
const GENERIC = new Set(tokenize("hyperexecute lambdatest testmu yaml test tests job run"));
export function localIsWeak(hits, query) {
  const q = [...new Set(tokenize(keywords(query)))].filter((t) => !GENERIC.has(t));
  if (!hits.length) return true;
  if (!q.length) return false;
  const have = new Set(tokenize(`${hits[0].topic || ""} ${hits[0].section || ""} ${hits[0].text || ""}`));
  const need = q.length <= 4 ? q.length : Math.ceil(q.length * 0.8); // short questions: every specific word
  return q.filter((t) => have.has(t)).length < need;
}

export function docsStatus() {
  const dir = docsDir();
  const pages = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length : 0;
  return { enabled: docsEnabled(), site: `${SITE}/support/docs`, cachedPages: pages, dir };
}
