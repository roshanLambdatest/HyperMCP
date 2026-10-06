// Live Confluence knowledge base (e.g. https://lambdatest.atlassian.net/wiki/spaces/HYP).
// Auth: Atlassian Cloud API token (the same token works for Jira and Confluence) via Basic auth,
// or a Data Center Personal Access Token via Bearer auth.
//
// Env:
//   CONFLUENCE_BASE_URL   default https://lambdatest.atlassian.net/wiki
//   CONFLUENCE_SPACE      default HYP (comma-separated for several spaces)
//   ATLASSIAN_EMAIL       (alias: JIRA_EMAIL, CONFLUENCE_EMAIL)
//   ATLASSIAN_API_TOKEN   (alias: JIRA_API_TOKEN, CONFLUENCE_API_TOKEN)
//   ATLASSIAN_AUTH        "basic" (default) | "bearer"
//   CONFLUENCE_PUBLISH_SPACE  space for "Add to Confluence" pages (default HYP)
//   CONFLUENCE_PARENT_ID      page to create them under (optional)

const env = (...names) => names.map((n) => process.env[n]).find((v) => v && v.trim())?.trim();

export function confluenceConfig() {
  const baseUrl = (env("CONFLUENCE_BASE_URL") || "https://lambdatest.atlassian.net/wiki").replace(/\/+$/, "");
  const spaces = (env("CONFLUENCE_SPACE", "CONFLUENCE_SPACES") || "HYP").split(",").map((s) => s.trim()).filter(Boolean);
  const email = env("ATLASSIAN_EMAIL", "JIRA_EMAIL", "CONFLUENCE_EMAIL");
  const token = env("ATLASSIAN_API_TOKEN", "JIRA_API_TOKEN", "CONFLUENCE_API_TOKEN");
  const mode = (env("ATLASSIAN_AUTH") || "basic").toLowerCase();
  return { baseUrl, spaces, email, token, mode, configured: Boolean(token && (mode === "bearer" || email)) };
}

function authHeader(cfg) {
  if (cfg.mode === "bearer") return `Bearer ${cfg.token}`;
  return `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64")}`;
}

async function call(cfg, pathAndQuery, { method = "GET", body } = {}) {
  if (!cfg.configured) {
    throw new Error(
      "Confluence is not configured. Set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN (your Atlassian/Jira API token from https://id.atlassian.com/manage-profile/security/api-tokens) in the MCP server env."
    );
  }
  const res = await fetch(`${cfg.baseUrl}${pathAndQuery}`, {
    method,
    headers: { Authorization: authHeader(cfg), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    const hint =
      res.status === 401 ? " (check ATLASSIAN_EMAIL matches the account that owns the token, and that the token is not expired)" :
      res.status === 403 ? " (the account has no access to this space, or may not create pages in it)" :
      res.status === 404 ? " (wrong CONFLUENCE_BASE_URL or page id — Cloud URLs end in /wiki)" : "";
    throw new Error(`Confluence API ${res.status}${hint}: ${body}`);
  }
  return res.json();
}

// Confluence Cloud silently treats bad Basic credentials as an anonymous user (200 + empty results),
// so verify identity once per process before trusting an empty search.
let identity;
export async function whoAmI() {
  const cfg = confluenceConfig();
  if (!identity) {
    const u = await call(cfg, "/rest/api/user/current");
    identity = { type: u.type, displayName: u.displayName, email: u.email };
  }
  if (identity.type === "anonymous") {
    identity = undefined;
    throw new Error("Confluence rejected the credentials and treated the request as anonymous. Check ATLASSIAN_EMAIL is the Atlassian account email that created ATLASSIAN_API_TOKEN, and that the token is valid.");
  }
  return identity;
}

// "Add to Confluence" is turned off while the team tests builds that share one Confluence account,
// so nobody creates pages under that account. Set to true to bring it back.
// HE_CONFLUENCE_PUBLISH=on turns it on for one process (the smoke test's fake Confluence uses it).
export const CONFLUENCE_PUBLISH_ENABLED = false;
const publishEnabled = () => CONFLUENCE_PUBLISH_ENABLED || process.env.HE_CONFLUENCE_PUBLISH === "on";

// Create a page (Confluence storage format). Cloud uses the v2 API; Data Center (bearer) the v1 content API.
export async function createConfluencePage({ title, storage, space, parentId }) {
  if (!publishEnabled()) throw new Error("Add to Confluence is turned off for now. Use preview to see the page content.");
  const cfg = confluenceConfig();
  await whoAmI();
  const key = space || env("CONFLUENCE_PUBLISH_SPACE") || "HYP";
  const parent = parentId || env("CONFLUENCE_PARENT_ID") || undefined;
  let page;
  if (cfg.mode === "bearer") {
    page = await call(cfg, "/rest/api/content", { method: "POST", body: { type: "page", title, space: { key }, ancestors: parent ? [{ id: String(parent) }] : undefined, body: { storage: { value: storage, representation: "storage" } } } });
  } else {
    const sp = await call(cfg, `/api/v2/spaces?keys=${encodeURIComponent(key)}`);
    const spaceId = sp.results?.[0]?.id;
    if (!spaceId) throw new Error(`Confluence space ${key} not found, or this account can't see it.`);
    page = await call(cfg, "/api/v2/pages", { method: "POST", body: { spaceId, status: "current", title, parentId: parent ? String(parent) : undefined, body: { representation: "storage", value: storage } } });
  }
  const webui = page._links?.webui || "";
  return { id: page.id, title: page.title || title, space: key, url: webui ? `${page._links?.base || cfg.baseUrl}${webui}` : `${cfg.baseUrl}/pages/viewpage.action?pageId=${page.id}` };
}

const cqlEscape = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export async function searchConfluence(query, { limit = 8, space } = {}) {
  const cfg = confluenceConfig();
  if (cfg.mode !== "bearer") await whoAmI();
  const spaces = space ? [space] : cfg.spaces;
  const spaceClause = spaces.length ? `space in (${spaces.map((s) => `"${cqlEscape(s)}"`).join(",")}) AND ` : "";
  const cql = `${spaceClause}type=page AND (title ~ "${cqlEscape(query)}" OR text ~ "${cqlEscape(query)}") ORDER BY lastmodified DESC`;
  const data = await call(cfg, `/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}&excerpt=highlight`);
  return (data.results || []).map((r) => ({
    id: r.content?.id,
    title: r.content?.title || r.title,
    space: r.resultGlobalContainer?.title,
    url: r.url ? `${cfg.baseUrl}${r.url}` : undefined,
    lastModified: r.lastModified || r.friendlyLastModified,
    excerpt: (r.excerpt || "").replace(/@@@(end)?hl@@@/g, "").replace(/\s+/g, " ").trim(),
  }));
}

export async function getConfluencePage(idOrUrl, { maxChars = 30000 } = {}) {
  const cfg = confluenceConfig();
  const id = String(idOrUrl).match(/pages\/(\d+)/)?.[1] || String(idOrUrl).match(/pageId=(\d+)/)?.[1] || String(idOrUrl).trim();
  if (!/^\d+$/.test(id)) throw new Error(`Could not extract a Confluence page id from "${idOrUrl}". Pass the numeric id or a .../pages/<id>/... URL.`);
  if (cfg.mode !== "bearer") await whoAmI();
  const p = await call(cfg, `/rest/api/content/${id}?expand=body.storage,version,space`);
  const text = storageToText(p.body?.storage?.value || "");
  return {
    id: p.id,
    title: p.title,
    space: p.space?.key,
    version: p.version?.number,
    lastModified: p.version?.when,
    url: `${cfg.baseUrl}${p._links?.webui || ""}`,
    truncated: text.length > maxChars,
    content: text.slice(0, maxChars),
  };
}

// Convert Confluence storage-format XHTML into readable Markdown-ish text, keeping code/YAML blocks intact.
export function storageToText(html) {
  const named = { nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&", mdash: "—", ndash: "–", hellip: "…", middot: "·", times: "×", rarr: "→", larr: "←", bull: "•", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", trade: "™", deg: "°" };
  const decode = (s) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : named[e.toLowerCase()] ?? m
    );
  const codeBlocks = [];
  // Flatten paragraphs inside table cells so rows stay on one line.
  html = html.replace(/<table[\s\S]*?<\/table>/g, (t) => t.replace(/<\/?p[^>]*>/g, " ").replace(/<tr[^>]*>/g, "\n| "));
  let s = html.replace(/<ac:structured-macro[^>]*ac:name="(?:code|noformat)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g, (_, inner) => {
    const lang = (inner.match(/<ac:parameter ac:name="language">([^<]*)<\/ac:parameter>/) || [])[1] || "";
    const body = (inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/) || [])[1] || "";
    codeBlocks.push("\n```" + lang + "\n" + body.replace(/\s+$/, "") + "\n```\n");
    return `\u0000${codeBlocks.length - 1}\u0000`;
  });
  s = s
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/g, (_, b) => "\n```\n" + decode(b.replace(/<[^>]+>/g, "")) + "\n```\n")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_, n, t) => `\n${"#".repeat(+n)} ${t.replace(/<[^>]+>/g, "")}\n`)
    .replace(/<li[^>]*>/g, "\n- ")
    .replace(/<\/(p|div|tr|table|ul|ol)>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/t[dh]>/g, " | ")
    .replace(/<code>([\s\S]*?)<\/code>/g, "`$1`")
    .replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/g, "")
    .replace(/<[^>]+>/g, "");
  s = decode(s)
    .replace(/\u0000(\d+)\u0000/g, (_, i) => codeBlocks[+i])
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
