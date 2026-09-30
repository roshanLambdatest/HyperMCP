// LambdaTest (TestMu AI) capabilities in the repo's own language, mirroring
// https://www.testmuai.com/capabilities-generator/ — web capabilities live under "LT:Options",
// credentials always come from LT_USERNAME / LT_ACCESS_KEY.

import fs from "node:fs";
import path from "node:path";

const API = "https://api.lambdatest.com/api/v2/capability?grid=selenium";
const cache = new Map();

async function getJson(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`LambdaTest capability API ${res.status}`);
  const json = await res.json();
  cache.set(url, json);
  return json;
}

const FALLBACK = {
  browsers: ["Chrome", "MicrosoftEdge", "Firefox", "Safari"],
  versions: ["latest", "latest-1", "latest-2"],
  platforms: ["Windows 11", "Windows 10", "macOS Sequoia", "macOS Sonoma", "Linux"],
  resolutions: ["1920x1080", "1366x768", "1280x1024", "2560x1440"],
};

// Live option lists, step by step: browsers → versions → platforms → resolutions.
export async function capabilityOptions({ browser, version, platform } = {}) {
  try {
    const b = await getJson(API);
    const browsers = b.browsers.map((x) => ({ id: x.id, name: x.name })).filter((x) => ["chrome", "edge", "firefox", "safari", "opera", "ie"].includes(x.id));
    const cur = browsers.find((x) => x.name === browser || x.id === browser) || browsers.find((x) => x.id === b.default.id);
    const v = await getJson(`${API}&browser=${cur.id}`);
    const stable = [...new Set(v.versions.filter((x) => x.channel_type === "stable").map((x) => x.version))];
    const versions = ["latest", "latest-1", "latest-2", ...(v.versions.some((x) => x.channel_type === "beta") ? ["latest-beta"] : []), ...(v.versions.some((x) => x.channel_type === "dev") ? ["latest-dev"] : []), ...stable.slice(0, 15)];
    const concrete = !version || version.startsWith("latest") ? v.default.version : version;
    const o = await getJson(`${API}&browser=${cur.id}&version=${concrete}`);
    const platforms = o.oss.map((x) => ({ id: x.id, name: x.name }));
    const plat = platforms.find((x) => x.name === platform || x.id === platform) || platforms.find((x) => x.id === o.default?.id) || platforms[0];
    let resolutions = FALLBACK.resolutions;
    const idGuess = v.versions.find((x) => x.version === concrete && x.channel_type === "stable" && x.id.endsWith(plat.id.startsWith("win") ? "win" : /ubuntu|linux/.test(plat.id) ? "linux" : "mac"))?.id;
    if (idGuess) {
      const r = await getJson(`${API}&browser=${cur.id}&version=${concrete}&os=${plat.id}&browser_version_id=${idGuess}`);
      if (Array.isArray(r) && r[0]?.resolution?.length) resolutions = r[0].resolution;
    }
    return { live: true, browsers: browsers.map((x) => x.name), browser: cur.name, versions, platforms: platforms.map((x) => x.name), platform: plat.name, resolutions };
  } catch (e) {
    return { live: false, error: e.message, ...FALLBACK, browser: browser || "Chrome", platform: platform || "Windows 11" };
  }
}

// ---------- where does the repo create its driver? ----------

const DRIVER_PATTERNS = [
  { re: /new\s+RemoteWebDriver\s*\(/, kind: "remote", lang: "java" },
  { re: /new\s+(Android|IOS|Appium)Driver\s*[<(]/, kind: "remote", lang: "java" },
  { re: /new\s+(Chrome|Firefox|Edge|Safari|InternetExplorer)Driver\s*\(/, kind: "local", lang: "java" },
  { re: /webdriver\.Remote\s*\(/, kind: "remote", lang: "python" },
  { re: /webdriver\.(Chrome|Firefox|Edge|Safari)\s*\(/, kind: "local", lang: "python" },
  { re: /new\s+Builder\s*\(\s*\)/, kind: "builder", lang: "js" },
  { re: /\b(chromium|firefox|webkit)\.(launch|connect(OverCDP)?)\s*\(/, kind: "playwright", lang: "js" },
  { re: /exports\.config\s*=|export\s+const\s+config\s*[:=]/, kind: "wdio-config", lang: "js" },
  { re: /\bremote\s*\(\s*\{/, kind: "remote", lang: "js" },
  { re: /new\s+RemoteWebDriver\s*\(/, kind: "remote", lang: "csharp" },
  { re: /new\s+(Chrome|Firefox|Edge|Safari)Driver\s*\(/, kind: "local", lang: "csharp" },
  { re: /Selenium::WebDriver\.for\s*(\(\s*)?(:remote|$)|Capybara::Selenium::Driver\.new\s*\(/, kind: "remote", lang: "ruby" },
  { re: /Selenium::WebDriver\.for\s*\(?\s*:(chrome|firefox|edge|safari)/, kind: "local", lang: "ruby" },
  // a grid URL set in code or in a config file (properties, YAML, JSON…)
  { re: /(mobile-)?hub\.lambdatest\.com|cdp\.lambdatest\.com|\/wd\/hub\b|\b(grid|hub|remote|selenium)[_.-]?(url|host)\b\s*[:=]/i, kind: "hub-url", lang: "any" },
];
const CONFIG_FILE = /\.(properties|ya?ml|json|conf|ini|cfg|toml|env)$|(^|\/)\.env[\w.-]*$/;
const SKIP_FILE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|(^|\/)\.hyperexecute\/|hyperexecute[\w.-]*\.ya?ml$|(^|\/)\.github\/|\.gitlab-ci\.yml$|\.gitpod\.yml$)/i;

// Where the repo connects to a browser or device: driver creation, WebdriverIO config, grid URLs in code
// or config. Each point says whether it already uses LambdaTest and which variable holds the driver.
export function findDriverSetup(repoPath, profile) {
  const root = path.resolve(repoPath);
  const exts = { java: /\.(java|kt|groovy)$/, python: /\.(py|robot|resource)$/, node: /\.[cm]?[jt]s$/, csharp: /\.cs$/, ruby: /\.rb$/ }[profile.language] || /\.(java|py|[jt]s|cs|rb)$/;
  const lang = { node: "js", csharp: "csharp", python: "python", java: "java", ruby: "ruby" }[profile.language];
  const files = [...profile.tests.classes.map((c) => c.file), ...profile.tests.files];
  // plus any source or config file that could hold the connection
  const walk = (dir, depth = 0) => {
    if (depth > 12) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!/^(node_modules|\.git|target|build|dist|bin|obj|venv|\.venv|\.gradle|\.idea|coverage)$/.test(e.name)) walk(path.join(dir, e.name), depth + 1); }
      else if (exts.test(e.name) || CONFIG_FILE.test(e.name)) files.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join("/"));
    }
  };
  try { walk(path.join(root, profile.projectRoot || profile.packageRoot || "")); } catch {}
  const out = [];
  for (const rel of [...new Set(files)]) {
    if (SKIP_FILE.test(rel)) continue;
    const isConfig = CONFIG_FILE.test(rel) && !exts.test(rel);
    let text;
    try { text = fs.readFileSync(path.join(root, rel), "utf8"); } catch { continue; }
    if (text.length > 500000) continue;
    const usesLT = /lambdatest|testmuai|LT:Options/i.test(text);
    text.split("\n").forEach((line, i) => {
      for (const p of DRIVER_PATTERNS) {
        if ((p.lang !== lang && p.lang !== "any") || (isConfig && p.kind !== "hub-url") || !p.re.test(line)) continue;
        if (p.kind === "wdio-config" && !/wdio/.test(rel)) continue;
        if (p.kind === "remote" && lang === "js" && !/webdriverio|wdio|appium/i.test(text)) continue;
        // a grid URL line: LambdaTest if it says so; another host named on it means it's not
        const hubHere = p.kind !== "hub-url" ? usesLT : /lambdatest|testmuai/i.test(line) || (usesLT && !/localhost|\d+\.\d+\.\d+\.\d+|[\w-]+\.(com|net|io|org|dev|local|internal)\b/i.test(line));
        // assigned to a variable? (driver = new ChromeDriver() / self.driver = webdriver.Chrome() / { @driver = … })
        const before = line.slice(0, line.search(p.re));
        const v = before.match(/([@\w.\[\]]+)\s*=\s*(?:await\s+)?$/);
        out.push({ file: rel, line: i + 1, kind: p.kind, code: line.trim().slice(0, 140), usesLambdaTest: hubHere, indent: line.match(/^\s*/)[0], driverVar: v?.[1] });
        break; // one point per line
      }
    });
  }
  // driver creation first, then configs; grid URLs inside a driver-creation line are already covered
  return out.sort((a, b) => (a.kind === "hub-url") - (b.kind === "hub-url"));
}

// ---------- code generation ----------

const OPTIONS_CLASS = { Chrome: "ChromeOptions", MicrosoftEdge: "EdgeOptions", Firefox: "FirefoxOptions", Safari: "SafariOptions", Opera: "ChromeOptions", "Internet Explorer": "InternetExplorerOptions" };
const JAVA_PKG = { ChromeOptions: "chrome", EdgeOptions: "edge", FirefoxOptions: "firefox", SafariOptions: "safari", InternetExplorerOptions: "ie" };

export function buildCapabilities(o) {
  const lt = { platformName: o.platform || "Windows 11" };
  if (o.resolution) lt.resolution = o.resolution;
  lt.project = o.project || "HyperExecute";
  lt.build = o.build || "HyperExecute build";
  if (o.name) lt.name = o.name;
  if (o.video !== false) lt.video = true;
  if (o.network) lt.network = true;
  if (o.console) lt.console = true;
  if (o.visual) lt.visual = true;
  if (o.tunnel) lt.tunnel = true;
  if (o.headless) lt.headless = true;
  if (o.geoLocation) lt.geoLocation = o.geoLocation;
  if (o.timezone) lt.timezone = o.timezone;
  if (o.seleniumVersion) lt.selenium_version = o.seleniumVersion;
  lt.w3c = true;
  lt.plugin = o.plugin || "hyperexecute-studio";
  return { browserName: o.browser || "Chrome", browserVersion: o.version || "latest", "LT:Options": lt };
}

const lit = {
  java: (v) => (typeof v === "string" ? JSON.stringify(v) : String(v)),
  python: (v) => (typeof v === "string" ? JSON.stringify(v) : v === true ? "True" : v === false ? "False" : String(v)),
  js: (v) => JSON.stringify(v),
  csharp: (v) => (typeof v === "string" ? JSON.stringify(v) : String(v).toLowerCase()),
};

// Appium on LambdaTest real devices (mobile-hub). The app must be uploaded to LambdaTest first; its id (lt://…) goes in "app".
const MOBILE_HUB = "https://mobile-hub.lambdatest.com/wd/hub";
export function mobileCapabilities(o = {}) {
  const lt = {
    platformName: o.mobilePlatform || "Android",
    deviceName: o.device || (o.mobilePlatform === "iOS" ? "iPhone 15" : "Galaxy S23"),
    platformVersion: o.platformVersion || (o.mobilePlatform === "iOS" ? "17" : "13"),
    app: o.app || "lt://APP_ID",
    isRealMobile: true,
    project: o.project || "HyperExecute",
    build: o.build || "HyperExecute build",
  };
  if (o.video !== false) lt.video = true;
  if (o.network) lt.network = true;
  lt.devicelog = true;
  if (o.tunnel) lt.tunnel = true;
  lt.w3c = true;
  lt.plugin = o.plugin || "hyperexecute-studio";
  return { "LT:Options": lt };
}

// The connection code for the chosen capabilities, written to replace the repo's own driver creation in place.
// DRIVER stands for the variable the repo already assigns its driver to (filled per connection point).
export function generateConnection(profile, opts = {}) {
  let caps = buildCapabilities(opts);
  const lt = caps["LT:Options"];
  let hub = "https://hub.lambdatest.com/wd/hub";
  // real-device capabilities when asked for, or by default for Appium repos
  const mobile = opts.mobile === true || (opts.mobile !== false && profile.drivers?.includes("appium"));
  const fw = profile.primaryFramework;
  const optClass = OPTIONS_CLASS[caps.browserName] || "ChromeOptions";
  const rest = (o) => Object.entries(o).filter(([k]) => k !== "platformName");
  let language, snippet, imports = [];

  if (mobile && ["java", "python", "node"].includes(profile.language)) {
    // Appium on LambdaTest real devices: the app is uploaded to LambdaTest first and referenced as lt://APP_ID
    caps = mobileCapabilities(opts);
    hub = MOBILE_HUB;
    const entries = Object.entries(caps["LT:Options"]);
    if (profile.language === "java") {
      language = "java";
      imports = ["io.appium.java_client.AppiumDriver", "org.openqa.selenium.MutableCapabilities", "java.net.URL", "java.util.HashMap"];
      snippet = `MutableCapabilities capabilities = new MutableCapabilities();
HashMap<String, Object> ltOptions = new HashMap<String, Object>();
ltOptions.put("username", System.getenv("LT_USERNAME"));
ltOptions.put("accessKey", System.getenv("LT_ACCESS_KEY"));
${entries.map(([k, v]) => `ltOptions.put(${lit.java(k)}, ${lit.java(v)});`).join("\n")}
capabilities.setCapability("LT:Options", ltOptions);
DRIVER = new AppiumDriver(new URL("${MOBILE_HUB}"), capabilities);`;
    } else if (profile.language === "python") {
      language = "python";
      imports = ["import os", "from appium import webdriver", "from appium.options.common import AppiumOptions"];
      snippet = `options = AppiumOptions()
lt_options = {"username": os.environ.get("LT_USERNAME"), "accessKey": os.environ.get("LT_ACCESS_KEY")}
${entries.map(([k, v]) => `lt_options[${lit.python(k)}] = ${lit.python(v)}`).join("\n")}
options.set_capability("LT:Options", lt_options)
DRIVER = webdriver.Remote("${MOBILE_HUB}", options=options)`;
    } else {
      language = "js";
      snippet = `// in the WebdriverIO options / remote() call:
protocol: "https",
hostname: "mobile-hub.lambdatest.com",
port: 443,
path: "/wd/hub",
capabilities: ${jsWithCreds(caps, "username")},`;
    }
  } else if (profile.language === "ruby") {
    language = "ruby";
    const rubyBrowser = { Chrome: "chrome", MicrosoftEdge: "edge", Firefox: "firefox", Safari: "safari" }[caps.browserName] || "chrome";
    snippet = `options = Selenium::WebDriver::Options.${rubyBrowser}
options.browser_version = ${JSON.stringify(caps.browserVersion)}
options.platform_name = ${JSON.stringify(lt.platformName)}
options.add_option("LT:Options", {
  "username" => ENV["LT_USERNAME"],
  "accessKey" => ENV["LT_ACCESS_KEY"],
${rest(lt).map(([k, v]) => `  ${JSON.stringify(k)} => ${JSON.stringify(v)},`).join("\n")}
})
DRIVER = Selenium::WebDriver.for(:remote, url: "${hub}", options: options)`;
  } else if (profile.language === "java") {
    language = "java";
    imports = ["java.net.URL", "java.util.HashMap", `org.openqa.selenium.${JAVA_PKG[optClass]}.${optClass}`, "org.openqa.selenium.remote.RemoteWebDriver"];
    snippet = `${optClass} browserOptions = new ${optClass}();
browserOptions.setPlatformName(${lit.java(lt.platformName)});
browserOptions.setBrowserVersion(${lit.java(caps.browserVersion)});
HashMap<String, Object> ltOptions = new HashMap<String, Object>();
ltOptions.put("username", System.getenv("LT_USERNAME"));
ltOptions.put("accessKey", System.getenv("LT_ACCESS_KEY"));
${rest(lt).map(([k, v]) => `ltOptions.put(${lit.java(k)}, ${lit.java(v)});`).join("\n")}
browserOptions.setCapability("LT:Options", ltOptions);
DRIVER = new RemoteWebDriver(new URL("${hub}"), browserOptions);`;
  } else if (profile.language === "python") {
    language = "python";
    imports = ["import os", "from selenium import webdriver", `from selenium.webdriver import ${optClass}`];
    snippet = `options = ${optClass}()
options.browser_version = ${lit.python(caps.browserVersion)}
options.platform_name = ${lit.python(lt.platformName)}
lt_options = {"username": os.environ.get("LT_USERNAME"), "accessKey": os.environ.get("LT_ACCESS_KEY")}
${rest(lt).map(([k, v]) => `lt_options[${lit.python(k)}] = ${lit.python(v)}`).join("\n")}
options.set_capability("LT:Options", lt_options)
DRIVER = webdriver.Remote(command_executor="${hub}", options=options)`;
  } else if (profile.language === "csharp") {
    language = "csharp";
    imports = ["System", "System.Collections.Generic", "OpenQA.Selenium.Remote"];
    snippet = `var browserOptions = new ${optClass}();
browserOptions.PlatformName = ${lit.csharp(lt.platformName)};
browserOptions.BrowserVersion = ${lit.csharp(caps.browserVersion)};
var ltOptions = new Dictionary<string, object>();
ltOptions.Add("username", Environment.GetEnvironmentVariable("LT_USERNAME"));
ltOptions.Add("accessKey", Environment.GetEnvironmentVariable("LT_ACCESS_KEY"));
${rest(lt).map(([k, v]) => `ltOptions.Add(${lit.csharp(k)}, ${lit.csharp(v)});`).join("\n")}
browserOptions.AddAdditionalOption("LT:Options", ltOptions);
DRIVER = new RemoteWebDriver(new Uri("${hub}"), browserOptions);`;
  } else if (profile.language === "node" && fw === "playwright") {
    language = "js";
    hub = "wss://cdp.lambdatest.com/playwright";
    caps = { browserName: caps.browserName === "Safari" ? "pw-webkit" : caps.browserName, browserVersion: caps.browserVersion, "LT:Options": { platform: lt.platformName, build: lt.build, project: lt.project, video: lt.video, network: lt.network, console: lt.console, tunnel: lt.tunnel, plugin: lt.plugin } };
    snippet = `const capabilities = ${jsWithCreds(caps, "user")};
DRIVER = await chromium.connect(\`${hub}?capabilities=\${encodeURIComponent(JSON.stringify(capabilities))}\`);`;
  } else if (profile.language === "node" && fw === "webdriverio") {
    language = "js";
    snippet = `// in this config (and remove chromedriver / selenium-standalone from services):
user: process.env.LT_USERNAME,
key: process.env.LT_ACCESS_KEY,
hostname: "hub.lambdatest.com",
port: 443,
protocol: "https",
path: "/wd/hub",
capabilities: [${JSON.stringify(caps, null, 2)}],`;
  } else {
    language = "js";
    snippet = `const capabilities = ${jsWithCreds(caps, "username")};
DRIVER = await new Builder().usingServer("${hub}").withCapabilities(capabilities).build();`;
  }

  return {
    language,
    framework: fw,
    hub,
    capabilities: caps,
    snippet,
    imports,
    notes: [
      "Credentials are read from LT_USERNAME / LT_ACCESS_KEY — the Studio's ▶ Run passes yours; on HyperExecute they come from the YAML env (secrets).",
      ...(lt.tunnel ? ["tunnel: true needs a running LambdaTest tunnel (set tunnel: true in the HyperExecute YAML too)."] : []),
      ...(hub === MOBILE_HUB ? ["Real devices: upload your .apk/.ipa to LambdaTest first (App Automation → upload, or the upload API) and put the returned lt://… id in \"app\". deviceName and platformVersion must match a device LambdaTest offers."] : []),
      "The change goes into the repo's own connection code (see connection points). No new helper or connection file is created.",
    ],
  };
}

// JS capabilities with credentials read from the environment
function jsWithCreds(caps, userKey) {
  const c = structuredClone(caps);
  c["LT:Options"] = { [userKey]: "__LT_USERNAME__", accessKey: "__LT_ACCESS_KEY__", ...c["LT:Options"] };
  return JSON.stringify(c, null, 2).replace(/"__(LT_USERNAME|LT_ACCESS_KEY)__"/g, "process.env.$1");
}

// For each place the repo connects, what to change there, in that file. Nothing is written.
export function planConnectionChanges(setup, conn) {
  return setup.map((s) => {
    const indent = (s.indent ?? "");
    const driverVar = s.driverVar || "driver";
    const code = conn.snippet.replace(/\bDRIVER\b/g, driverVar).split("\n").map((l) => (l ? indent + l : l)).join("\n");
    let change;
    if (s.kind === "hub-url") change = s.usesLambdaTest ? `Already points at LambdaTest. Keep it, or set it to ${conn.hub}.` : `Grid URL: change it to ${conn.hub}. Keep username/key out of the URL; the code reads LT_USERNAME / LT_ACCESS_KEY.`;
    else if (s.usesLambdaTest) change = "Already connects to LambdaTest. Change only the capabilities the user asked for (LT:Options below); leave the rest of the code as it is.";
    else if (s.kind === "wdio-config") change = "WebdriverIO config: point it at the LambdaTest hub with the settings below.";
    else if (s.kind === "playwright") change = `Replace this local launch with a connection to LambdaTest (${conn.hub}).`;
    else if (s.kind === "local") change = `Replace this local browser with a remote driver on LambdaTest (${conn.hub}), assigned to the same variable (${driverVar}).`;
    else change = `Point this connection at LambdaTest (${conn.hub}) with the capabilities below.`;
    return { file: s.file, line: s.line, kind: s.kind, current: s.code, usesLambdaTest: s.usesLambdaTest, change, code: s.kind === "hub-url" ? undefined : code, imports: s.kind === "hub-url" || !conn.imports?.length ? undefined : conn.imports };
  });
}
