// The built-in chat assistant. No AI model: requests are matched to generator options, questions to
// answers built from the current repo/YAML, and pasted logs go to the same diagnosis rules as the
// Diagnose tab. Returns a plan the app applies:
//   { reply, chips?: [{ label, send? | prefill? }], options?, done?, reset?, undo?, optimize?, diagnose?, tab?, ai? }
// `ai: true` means "not understood" — the app hands it to Claude when the visitor connected one.

const OS = ["linux", "mac", "mac13", "win", "win11"];
const OS_NAME = { linux: "Linux", mac: "macOS", mac13: "macOS 13", win: "Windows", win11: "Windows 11" };
import { plural, fwName, stackLine } from "./names.js";

// ---------- recognizers ----------

export function looksLikeLog(t) {
  const lines = t.split("\n").filter((l) => l.trim());
  const errorish = /(exception|error|failed|failure|not found|tests run:|refused|timed? ?out|ERR::|fatal|denied|cannot|unable to)/i;
  return (lines.length >= 3 && lines.some((l) => errorish.test(l))) || (t.length > 400 && errorish.test(t));
}

const ask = (t) => /\?\s*$/.test(t) || /^(why|what|how|is|are|can|does|do|which|where|when|explain|tell me|should)\b/i.test(t.trim());

// Option changes described in plain English → generator option patch + what was understood.
export function parseOptions(text, profile) {
  const t = text.toLowerCase();
  const o = {};
  const done = [];
  const multiOs = OS.filter((x) => new RegExp(`\\b${x}\\b`).test(t) || (x === "win" && /\bwindows\b(?!\s*11)/.test(t)) || (x === "mac" && /\bmacos\b/.test(t)));
  if (/(both|across|multi|all|every)\b.*\b(os|platforms?|operating systems?)|\b(linux|mac\w*|win\w*)\s+(and|&|\+)\s+(linux|mac\w*|win\w*)/.test(t) && multiOs.length > 1) {
    Object.assign(o, { runsonMatrix: multiOs, executionMode: "matrix", yamlVersion: "0.1" });
    done.push(`every task on ${multiOs.map((x) => OS_NAME[x]).join(" and ")}`);
  } else if (/\bwin(dows)?\s*11\b/.test(t)) (o.runson = "win11"), done.push("Windows 11");
  else if (/\bwin(dows)?\b/.test(t)) (o.runson = "win"), done.push("Windows");
  else if (/\bmac(os)?\s*13\b/.test(t)) (o.runson = "mac13"), done.push("macOS 13");
  else if (/\bmac(os)?\b/.test(t)) (o.runson = "mac"), done.push("macOS");
  else if (/\b(linux|ubuntu)\b/.test(t)) (o.runson = "linux"), done.push("Linux");

  const conc = t.match(/(\d+)\s*(?:parallel\s*)?(vms?|machines|parallel|concurren\w*|nodes|workers|shards)\b/) || t.match(/(?:concurrency|parallel(?:ism)?|vms?)\s*(?:of|to|=|:|is)?\s*(\d+)/);
  if (conc) {
    const n = Math.max(1, Math.min(500, +conc[1]));
    (o.concurrency = n), done.push(`${plural(n, "VM")} in parallel`);
  }
  const split = t.match(/(?:split|shard|distribute|divide)\w*\s+(?:it\s+|tests\s+)?(?:by|on|per)\s+(class|classes|method|methods|suite|suites|file|files|spec|specs|feature|features|scenario|scenarios|tag|tags)/) || t.match(/\bper\s+(class|method|suite|file|spec|feature|scenario|tag)\b/) || t.match(/\bone\s+(class|method|file|spec|feature|scenario)\s+per\s+(vm|task|machine)/);
  if (split) {
    const SINGLE = { classes: "class", methods: "method", suites: "suite", files: "file", spec: "file", specs: "file", features: "feature", scenarios: "scenario", tags: "tag" };
    const s = SINGLE[split[1]] || split[1];
    (o.splitBy = s), done.push(`split by ${s}`);
  }
  if (/\bv?0\.2\b|framework (field|mode|runner)|native (runner|discovery)/.test(t)) (o.yamlVersion = "0.2"), done.push("YAML v0.2");
  else if (/\bv?0\.1\b|raw discovery/.test(t)) (o.yamlVersion = "0.1"), done.push("YAML v0.1");
  if (/\bmatrix\b/.test(t) && !o.executionMode) (o.executionMode = "matrix"), (o.yamlVersion = "0.1"), done.push("matrix mode");
  if (/\bautosplit\b/.test(t)) (o.executionMode = "autosplit"), done.push("autosplit");
  if (/\btunnel\b/.test(t)) {
    o.tunnel = !/(no|without|disable|remove|turn off|off)\s+(the\s+)?tunnel|tunnel\s+off/.test(t);
    done.push(`tunnel ${o.tunnel ? "on" : "off"}`);
  }
  if (/\b(no|disable|without|turn off)\s+retr/.test(t)) (o.retryOnFailure = false), (o.maxRetries = null), done.push("no retries");
  else {
    const r = t.match(/(\d)\s*retr/) || t.match(/retr\w*\s*(?:to|=|:|of)?\s*(\d)/);
    if (r) (o.retryOnFailure = +r[1] > 0), (o.maxRetries = +r[1] > 0 ? Math.min(5, +r[1]) : null), done.push(+r[1] ? plural(+r[1], "retry") : "no retries");
  }
  const to = t.match(/timeout\s*(?:of|to|=|:)?\s*(\d+)/) || t.match(/(\d+)\s*(?:min|minutes?)\s*timeout/);
  if (to) (o.globalTimeout = Math.max(1, Math.min(150, +to[1]))), done.push(`${o.globalTimeout}-minute timeout`);

  const browsers = ["chrome", "firefox", "edge", "safari", "webkit"].filter((w) => new RegExp(`\\b${w}\\b`).test(t));
  if (browsers.length > 1) {
    Object.assign(o, { extraMatrix: { ...(o.extraMatrix || {}), browser: browsers }, executionMode: "matrix", yamlVersion: "0.1" });
    done.push(`a browser axis: ${browsers.join(", ")} (tests read it as $browser)`);
  }
  const projects = profile?.playwrightProjects || [];
  if (projects.length > 1 && /\bprojects?\b/.test(t) && /(spread|split|separate|each|own|per|parallel|across)/.test(t)) {
    Object.assign(o, { extraMatrix: { ...(o.extraMatrix || {}), project: projects }, executionMode: "matrix", yamlVersion: "0.1" });
    done.push(`one Playwright project per task (${projects.join(", ")})`);
  }
  const tags = [...new Set(text.match(/@[\w-]+/g) || [])];
  if (tags.length && /\btags?\b|\bonly\b|\brun\b/.test(t)) Object.assign(o, { matrixValues: tags, splitBy: "tag", executionMode: "matrix", yamlVersion: "0.1" }), done.push(`tags ${tags.join(", ")}`);

  const mvn = (profile?.mavenProfiles || []).map((p) => p.id);
  const pm = text.match(/(?:maven\s+)?profile\s+["'`]?([\w.-]+)/i) || text.match(/\B-P\s*([\w.-]+)/);
  if (pm && mvn.includes(pm[1])) (o.mavenProfile = pm[1]), done.push(`Maven profile ${pm[1]}`);

  // env values: BASE_URL=https://…, set BASE_URL to …, BASE_URL is …
  const env = {};
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*(?:=|\bto\b|\bis\b|:)\s*("[^"]*"|'[^']*'|\S+)/g)) {
    if (/^(YAML|CLI|API|VMS?)$/.test(m[1])) continue;
    env[m[1]] = m[2].replace(/^["']|["']$/g, "").replace(/[.,;]$/, "");
  }
  if (Object.keys(env).length) (o.extraEnv = env), done.push(`${Object.keys(env).join(", ")} set`);
  return { options: o, done };
}

// ---------- answers ----------

function explainYaml(ctx) {
  const d = ctx.parsed || {};
  const r = ctx.result || {};
  const b = [];
  b.push(`**YAML v${d.version ?? r.yamlVersion}** for ${fwName(r.framework) || "your framework"}, running on **${OS_NAME[d.runson] || d.runson}**${d.matrix?.os ? ` (every task on ${d.matrix.os.map((x) => OS_NAME[x] || x).join(" and ")})` : ""}.`);
  if (d.framework?.name) b.push(`HyperExecute's native **${d.framework.name}** runner discovers the tests itself and splits them by **${d.framework.discoveryType || "class"}**.`);
  else if (d.autosplit && d.testDiscovery) b.push(`**Autosplit**: HyperExecute runs \`${cut(d.testDiscovery.command)}\` to list the tests, then runs each with \`${cut(d.testRunnerCommand)}\` (\`$test\` becomes one item).`);
  else if (d.matrix) b.push(`**Matrix**: one task per combination of ${Object.entries(d.matrix).map(([k, v]) => `${k} (${Array.isArray(v) ? v.length : 1})`).join(" × ")}, each running \`${cut((d.testSuites || [])[0])}\`.`);
  b.push(`Up to **${plural(d.concurrency ?? 1, "VM")}** run at once${d.retryOnFailure ? `; failed tests are retried ${d.maxRetries ?? 1}×` : "; no retries"}; the job stops after **${d.globalTimeout ?? "–"} minutes**.`);
  if (d.pre?.length) b.push(`Before the tests, each VM runs ${d.pre.map((p) => `\`${cut(p, 70)}\``).join(", ")}.`);
  const env = Object.entries(d.env || {});
  const secrets = env.filter(([, v]) => String(v).includes(".secrets.")).map(([k]) => `\`${k}\``);
  const todo = env.filter(([, v]) => String(v).startsWith("<set ")).map(([k]) => k);
  if (secrets.length) b.push(`Secrets it expects in HyperExecute: ${secrets.join(", ")}.`);
  if (todo.length) b.push(`**Fill in** before running: ${todo.map((s) => `\`${s}\``).join(", ")}. Tell me, e.g. \`${todo[0]}=https://…\`.`);
  if (d.tunnel) b.push("A LambdaTest **tunnel** is on, so tests can reach internal URLs.");
  if (d.partialReports) b.push(`Reports: ${[].concat(d.partialReports).map((p) => `${p.frameworkName} (${p.type})`).join(", ")}; artefacts are kept after the run.`);
  return b.map((x) => `- ${x}`).join("\n");
}
const cut = (s, n = 90) => (String(s ?? "").length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));

const FAQ = [
  [/\b(v?0\.2|v?0\.1|version)\b/, () => "**YAML v0.2** uses HyperExecute's native runner (a `framework:` block). HyperExecute discovers the tests itself for Maven/Gradle TestNG, JUnit and Spock and for .NET NUnit/MSTest, and caches dependencies automatically.\n\nIt can't do matrix mode, custom commands or tag/file/feature/scenario splitting; those need **v0.1**, where the YAML carries the discovery and runner commands. A v0.2 file must never contain `testDiscovery`, or the job runs 0 tests."],
  [/\b(autosplit|matrix)\b/, () => "**Autosplit** lists the tests at run time (the discovery command) and spreads them over the VMs, balancing by past durations. It's the best default.\n\n**Matrix** runs one task per combination of fixed values: tags, browsers, operating systems. Use it for cross-browser or multi-OS runs, or an explicit list."],
  [/\btunnel\b/, () => "`tunnel: true` starts a LambdaTest tunnel for the job, so tests on HyperExecute VMs can reach internal, staging or localhost URLs. Say \"add a tunnel\" if your tests hit an address that isn't public."],
  [/\b(concurrency|parallel|vms?)\b/, (ctx) => `\`concurrency\` is how many VMs run at the same time: ${ctx.parsed?.concurrency ?? "not set"} now. More VMs finish sooner, up to the number of test units there are to split. Say "use 10 VMs" to change it.`],
  [/\b(retr(y|ies))\b/, () => "`retryOnFailure` with `maxRetries` reruns failed tests 1 to 5 times, to absorb flaky failures; real failures still fail. Say \"2 retries\" or \"no retries\"."],
  [/\b(secret|credential|password|token|access key|username)s?\b/, (ctx) => ctx.credsOn ? "Your LambdaTest username and key are **in the YAML** (from Settings). Don't commit that file to a shared repo." : "`LT_USERNAME` and `LT_ACCESS_KEY` are **secret references** (`${{ .secrets.… }}`). Create both secrets in HyperExecute → Settings → Secrets, or enter your account in **Settings** here to put them straight into the YAML."],
  [/\b(cache|caching|dependenc)/, () => "The YAML installs dependencies in `pre` and caches them with `cacheKey` (a checksum of your lock or build file) and `cacheDirectories`, so repeat runs skip the download. v0.2 caches Maven, Gradle and NuGet on its own."],
  [/\b(report|artefact|artifact)s?\b/, () => "`report: true` with `partialReports` builds one HyperExecute report from every VM's results (JUnit XML, TestNG HTML, Cucumber JSON…). `uploadArtefacts` keeps files such as screenshots and HTML reports for download after the job."],
];

// ---------- entry ----------

export function respond(text, ctx) {
  const t = text.trim();
  const low = t.toLowerCase();
  if (!t) return { reply: "Tell me what you need, e.g. \"run on Windows 11 with 10 VMs\"." };
  if (looksLikeLog(t)) return { diagnose: t };
  if (/^(help|\?|what can you do|commands?)\b/.test(low)) return help();
  if (/^(undo|revert|go back)\b/.test(low)) return { undo: true };
  if (/^(reset|start over|defaults?)\b/.test(low)) return { reset: true };
  if (/\b(optimi[sz]e|faster|cheaper|speed ?up|save (time|money|cost))\b/.test(low)) return { optimize: true };
  const ci = /github\s*actions?|\bgithub\b.*\b(ci|workflow|pipeline)/.test(low) ? "github" : /\bgitlab\b/.test(low) ? "gitlab" : /\bjenkins(file)?\b/.test(low) ? "jenkins" : /\bazure\b/.test(low) ? "azure" : null;
  if (ci || /\b(ci|pipeline|workflow)\b.*\b(file|yaml|yml|set ?up|run|every push)|\brun (it |this )?(from|in|on) (my )?ci\b|\b(ci|pipeline)\b\s*\??$/.test(low)) return { pipeline: ci || "ask" };
  if (/\b(explain|walk me through|what does (this|the|my) yaml|describe (this|the|my) yaml)\b/.test(low)) return { reply: explainYaml(ctx), chips: [{ label: "Is it valid?", send: "Is it valid?" }, { label: "How do I run it?", send: "How do I run it?" }] };
  if (/\b(valid|errors?|wrong|issues?|problems?|warnings?)\b/.test(low) && ask(t)) {
    const v = ctx.validation;
    if (!v) return { reply: "There's no YAML yet." };
    if (!v.errors.length && !v.warnings.length) return { reply: "**Valid**: no errors or warnings against HyperExecute's rules." };
    const list = (xs) => xs.map((e) => `- ${ctx.visitor(e)}`).join("\n");
    return { reply: [v.errors.length ? `**${plural(v.errors.length, "error")}**\n${list(v.errors)}` : "**No errors.**", v.warnings.length ? `**${plural(v.warnings.length, "warning")}**\n${list(v.warnings)}` : ""].filter(Boolean).join("\n\n"), tab: "checks" };
  }
  if (/\bhow many tests|\btests? (found|detected)|\bwhat tests\b/.test(low)) {
    const s = ctx.summary.tests;
    const parts = [["test class", s.classCount], ["test method", s.methodCount], ["spec file", s.fileCount], ["feature", s.featureCount], ["scenario", s.scenarioCount], ["test function", s.functionCount]].filter(([, n]) => n).map(([w, n]) => plural(n, w));
    return { reply: parts.length ? `I found ${parts.join(", ")}.${s.tags?.length ? ` Tags: ${s.tags.slice(0, 10).join(", ")}.` : ""}` : "I didn't find tests in the usual places. Which folder holds them?" };
  }
  if ((/\b(run|start|launch|execute|trigger)\b/.test(low) && ask(t)) || /\bcli\b/.test(low)) {
    return { reply: "1. Save the YAML at the root of your repo as `hyperexecute.yaml`.\n2. Download the HyperExecute CLI for your OS.\n3. Run `./hyperexecute --user \"$LT_USERNAME\" --key \"$LT_ACCESS_KEY\" --config hyperexecute.yaml`.\n\nThe **Run** tab has the exact commands for your OS. If the job fails, paste its log here and I'll find the cause.", tab: "run" };
  }
  if (/\b(scan|security|hard.?coded|leak)/.test(low)) {
    const sc = ctx.scan;
    return { reply: `${sc.credentials.length ? `**${plural(sc.credentials.length, "hard-coded LambdaTest credential")}** in your code; ${sc.credentials.filter((c) => c.autoFix).length} can be fixed automatically.` : "No hard-coded LambdaTest credentials."} ${sc.reporting.length ? `${plural(sc.reporting.length, "place")} send results outside HyperExecute.` : ""}`.trim(), tab: "security" };
  }

  // a question ("what is a tunnel?") gets an answer; only requests ("add a tunnel") change the setup
  const request = /\b(add|enable|disable|turn|use|set|switch|make|change|run|split|give|want|need|remove|drop|increase|decrease|only)\b/.test(low);
  if (ask(t) && !request) for (const [re, fn] of FAQ) if (re.test(low)) return { reply: fn(ctx) };

  const { options, done } = parseOptions(t, ctx.profile);
  if (Object.keys(options).length) return { options, done };

  if (ask(t)) for (const [re, fn] of FAQ) if (re.test(low)) return { reply: fn(ctx) };
  // anything else that reads like a question: the best matching section of the HyperExecute notes
  if (ctx.searchKb && (ask(t) || t.split(/\s+/).length >= 3)) {
    const hit = ctx.searchKb(t).find((h) => h.matchedTerms >= 2 && h.text.length > 80);
    if (hit) {
      const body = hit.text.replace(/^#+\s.*\n+/, "").split("\n").filter((l) => !/^Source:/.test(l)).join("\n").trim();
      const excerpt = body.length > 900 ? body.slice(0, body.lastIndexOf("\n", 900) > 300 ? body.lastIndexOf("\n", 900) : 900) + "\n…" : body;
      return { reply: `From the HyperExecute notes, **${hit.section}**:\n\n${excerpt}`, ai: true, kb: true };
    }
  }
  if (/\bfail\s*fast\b/.test(low)) return { ai: true, reply: "Fail-fast isn't one of the generator options. Add HyperExecute's `failFast` key to the YAML by hand; the checks below validate it as you type." };
  return { ai: true, reply: "I didn't catch that. I can change the setup (\"Windows 11, 10 VMs, split by method\"), explain the YAML, check it, optimize it, or diagnose a failed run if you paste its log.", chips: help().chips };
}

export function help() {
  return {
    reply: "Here's what I can do:\n- **Change the setup**: \"run on Windows 11 with 10 VMs\", \"split by scenario\", \"add a tunnel\", \"Chrome and Firefox\", \"only @smoke and @regression\", \"2 retries\", \"BASE_URL=https://staging.example.com\"\n- **Explain** the YAML, or tell you whether it's **valid**\n- **Optimize** it for speed and cost\n- **Diagnose** a failed run: paste the job log\n- **Run it from CI**: \"GitHub Actions\", \"GitLab\", \"Jenkins\" or \"Azure DevOps\"\n- **Undo** the last change",
    chips: [{ label: "Explain this YAML", send: "Explain this YAML" }, { label: "Optimize it", send: "Optimize it" }, { label: "Windows 11 with 10 VMs", send: "Run on Windows 11 with 10 VMs" }],
  };
}

// First message after a repo is loaded: what was found, what was built, what to confirm.
export function welcome(ctx) {
  const { summary: p, result: r, repoName } = ctx;
  const t = p.tests;
  const unit = [["test class", t.classCount], ["spec file", t.fileCount], ["feature file", t.featureCount]].filter(([, n]) => n).map(([w, n]) => plural(n, w))[0];
  const inner = t.methodCount ? plural(t.methodCount, "test") : t.scenarioCount ? plural(t.scenarioCount, "scenario") : t.functionCount ? plural(t.functionCount, "test") : "";
  const stack = stackLine(p, r?.framework);
  const lines = [`I read **${repoName}**: ${stack}${unit ? `, ${unit}${inner ? ` (${inner})` : ""}` : ". I couldn't find tests in the usual places"}.`];
  if (r) lines.push(`I built a **v${r.yamlVersion}** YAML, ${r.executionMode === "matrix" ? "running a matrix" : `split by **${r.splitBy}**`} across **5 VMs** on Linux. Tell me what to change in plain words.`);
  const chips = [];
  const qs = p.questions || [];
  if (qs.length) {
    lines.push(`\nPlease check before you run it:\n${qs.map((q) => `- ${ctx.visitor(q)}`).join("\n")}`);
    for (const m of (ctx.profile.mavenProfiles || []).filter((x) => x.changesTests)) chips.push({ label: `Use profile ${m.id}`, send: `Use Maven profile ${m.id}` });
    if ((ctx.profile.playwrightProjects || []).length > 1) chips.push({ label: "One project per VM", send: "Spread the Playwright projects over separate VMs" });
    for (const q of qs) {
      const m = q.match(/The tests read ([\w, ]+)\./);
      if (m) for (const v of m[1].split(/,\s*/).slice(0, 3)) chips.push({ label: `Set ${v}`, prefill: `${v}=` });
    }
  }
  chips.push({ label: "Explain this YAML", send: "Explain this YAML" });
  if (chips.length < 4) chips.push({ label: "Optimize it", send: "Optimize it" });
  return { reply: lines.join("\n"), chips };
}
