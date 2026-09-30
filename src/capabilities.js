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
  { re: /new\s+(Chrome|Firefox|Edge|Safari|InternetExplorer)Driver\s*\(/, kind: "local", lang: "java" },
  { re: /webdriver\.Remote\s*\(/, kind: "remote", lang: "python" },
  { re: /webdriver\.(Chrome|Firefox|Edge|Safari)\s*\(/, kind: "local", lang: "python" },
  { re: /new\s+Builder\s*\(\s*\)/, kind: "builder", lang: "js" },
  { re: /\b(chromium|firefox|webkit)\.(launch|connect(OverCDP)?)\s*\(/, kind: "playwright", lang: "js" },
  { re: /exports\.config\s*=|export\s+const\s+config\s*[:=]/, kind: "wdio-config", lang: "js" },
  { re: /new\s+RemoteWebDriver\s*\(/, kind: "remote", lang: "csharp" },
  { re: /new\s+(Chrome|Firefox|Edge|Safari)Driver\s*\(/, kind: "local", lang: "csharp" },
];

export function findDriverSetup(repoPath, profile) {
  const root = path.resolve(repoPath);
  const exts = { java: /\.(java|kt)$/, python: /\.py$/, node: /\.[cm]?[jt]s$/, csharp: /\.cs$/ }[profile.language] || /\.(java|py|[jt]s|cs)$/;
  const lang = { node: "js", csharp: "csharp", python: "python", java: "java" }[profile.language];
  const out = [];
  const files = [...profile.tests.classes.map((c) => c.file), ...profile.tests.files];
  // plus any source file with a driver construction
  const walk = (dir, depth = 0) => {
    if (depth > 12) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!/^(node_modules|\.git|target|build|dist|bin|obj|venv|\.venv)$/.test(e.name)) walk(path.join(dir, e.name), depth + 1); }
      else if (exts.test(e.name)) files.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join("/"));
    }
  };
  try { walk(path.join(root, profile.projectRoot || profile.packageRoot || "")); } catch {}
  for (const rel of [...new Set(files)]) {
    let text;
    try { text = fs.readFileSync(path.join(root, rel), "utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => {
      for (const p of DRIVER_PATTERNS) {
        if (p.lang !== lang || !p.re.test(line)) continue;
        if (p.kind === "wdio-config" && !/wdio/.test(rel)) continue;
        const usesLT = /lambdatest|testmuai|LT:Options/i.test(text);
        out.push({ file: rel, line: i + 1, kind: p.kind, code: line.trim().slice(0, 140), usesLambdaTest: usesLT });
      }
    });
  }
  return out;
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

export function generateConnection(profile, opts = {}) {
  let caps = buildCapabilities(opts);
  const lt = caps["LT:Options"];
  let hub = "https://hub.lambdatest.com/wd/hub";
  // real-device capabilities when asked for, or by default for Appium repos
  const mobile = opts.mobile === true || (opts.mobile !== false && profile.drivers?.includes("appium"));
  const fw = profile.primaryFramework;
  const optClass = OPTIONS_CLASS[caps.browserName] || "ChromeOptions";
  let language, snippet, helper;

  if (false) {
  } else if (mobile && ["java", "python", "node"].includes(profile.language)) {
    // Appium on LambdaTest real devices: the app is uploaded to LambdaTest first and referenced as lt://APP_ID
    const m = mobileCapabilities(opts);
    const ml = m["LT:Options"];
    hub = MOBILE_HUB;
    caps = m;
    const entries = Object.entries(ml);
    if (profile.language === "java") {
      language = "java";
      const pkg = (profile.tests.classes[0]?.className || "").split(".").slice(0, -1).join(".");
      const lines = entries.map(([k, v]) => `        ltOptions.put(${lit.java(k)}, ${lit.java(v)});`).join("\n");
      snippet = `        MutableCapabilities capabilities = new MutableCapabilities();
        HashMap<String, Object> ltOptions = new HashMap<String, Object>();
        ltOptions.put("username", System.getenv("LT_USERNAME"));
        ltOptions.put("accessKey", System.getenv("LT_ACCESS_KEY"));
${lines}
        if (testName != null) ltOptions.put("name", testName);
        capabilities.setCapability("LT:Options", ltOptions);
        return new AppiumDriver(new URL("${MOBILE_HUB}"), capabilities);`;
      const dir = (profile.projectRoot ? profile.projectRoot + "/" : "") + "src/test/java/" + (pkg ? pkg.replace(/\./g, "/") + "/" : "");
      helper = {
        path: dir + "LambdaTestMobileDriverFactory.java",
        content: `${pkg ? `package ${pkg};\n\n` : ""}import io.appium.java_client.AppiumDriver;
import org.openqa.selenium.MutableCapabilities;

import java.net.MalformedURLException;
import java.net.URL;
import java.util.HashMap;

/** Appium on LambdaTest real devices. Credentials come from LT_USERNAME / LT_ACCESS_KEY. Generated by HyperExecute Studio. */
public final class LambdaTestMobileDriverFactory {
    private LambdaTestMobileDriverFactory() {}

    public static AppiumDriver create(String testName) throws MalformedURLException {
${snippet}
    }
}
`,
        usage: `AppiumDriver driver = LambdaTestMobileDriverFactory.create("My test");`,
      };
    } else if (profile.language === "python") {
      language = "python";
      const lines = entries.map(([k, v]) => `    lt_options[${lit.python(k)}] = ${lit.python(v)}`).join("\n");
      snippet = `    options = AppiumOptions()
    lt_options = {"username": os.environ.get("LT_USERNAME"), "accessKey": os.environ.get("LT_ACCESS_KEY")}
${lines}
    if test_name:
        lt_options["name"] = test_name
    options.set_capability("LT:Options", lt_options)
    return webdriver.Remote("${MOBILE_HUB}", options=options)`;
      helper = {
        path: (profile.tests.files[0] ? path.posix.dirname(profile.tests.files[0]) + "/" : "") + "lambdatest_mobile_driver.py",
        content: `"""Appium on LambdaTest real devices. Credentials come from LT_USERNAME / LT_ACCESS_KEY.
Generated by HyperExecute Studio."""
import os

from appium import webdriver
from appium.options.common import AppiumOptions


def create_driver(test_name=None):
${snippet}
`,
        usage: `from lambdatest_mobile_driver import create_driver\ndriver = create_driver("My test")`,
      };
    } else {
      language = "js";
      const lines = entries.map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
      snippet = `const capabilities = ${JSON.stringify(m, null, 2)};`;
      helper = {
        path: (profile.packageRoot ? profile.packageRoot + "/" : "") + "lambdatest.mobile.js",
        content: `// Appium (WebdriverIO) on LambdaTest real devices. Credentials come from LT_USERNAME / LT_ACCESS_KEY.
// Generated by HyperExecute Studio.
const { remote } = require("webdriverio");

async function createDriver(testName) {
  return remote({
    protocol: "https",
    hostname: "mobile-hub.lambdatest.com",
    port: 443,
    path: "/wd/hub",
    capabilities: {
      "LT:Options": {
        username: process.env.LT_USERNAME,
        accessKey: process.env.LT_ACCESS_KEY,
${lines}
        ...(testName ? { name: testName } : {}),
      },
    },
  });
}

module.exports = { createDriver };
`,
        usage: `const { createDriver } = require("./lambdatest.mobile");\nconst driver = await createDriver("My test");`,
      };
    }
  } else if (profile.language === "ruby") {
    language = "ruby";
    const rubyBrowser = { Chrome: "chrome", MicrosoftEdge: "edge", Firefox: "firefox", Safari: "safari" }[caps.browserName] || "chrome";
    const lines = Object.entries(lt).filter(([k]) => k !== "platformName").map(([k, v]) => `      ${JSON.stringify(k)} => ${JSON.stringify(v)},`).join("\n");
    snippet = `    options = Selenium::WebDriver::Options.${rubyBrowser}
    options.browser_version = ${JSON.stringify(caps.browserVersion)}
    options.platform_name = ${JSON.stringify(lt.platformName)}
    lt_options = {
      "username" => ENV["LT_USERNAME"],
      "accessKey" => ENV["LT_ACCESS_KEY"],
${lines}
    }
    lt_options["name"] = test_name if test_name
    options.add_option("LT:Options", lt_options)
    Selenium::WebDriver.for(:remote, url: HUB, options: options)`;
    helper = {
      path: (profile.tests.files[0] ? path.posix.dirname(profile.tests.files[0]) + "/" : profile.frameworks.includes("cucumber-ruby") ? "features/support/" : "") + "lambdatest_driver.rb",
      content: `# WebDriver on the LambdaTest (TestMu AI) grid. Credentials come from LT_USERNAME / LT_ACCESS_KEY.
# Generated by HyperExecute Studio.
require "selenium-webdriver"

module LambdaTestDriver
  HUB = "${hub}"

  def self.create(test_name = nil)
${snippet}
  end
end
`,
      usage: `require_relative "lambdatest_driver"\ndriver = LambdaTestDriver.create("My test")`,
    };

  } else if (profile.language === "java") {
    language = "java";
    const pkg = (profile.tests.classes[0]?.className || "").split(".").slice(0, -1).join(".");
    const lines = Object.entries(lt).filter(([k]) => k !== "platformName").map(([k, v]) => `        ltOptions.put(${lit.java(k)}, ${lit.java(v)});`).join("\n");
    const body = `        ${optClass} browserOptions = new ${optClass}();
        browserOptions.setPlatformName(${lit.java(lt.platformName)});
        browserOptions.setBrowserVersion(${lit.java(caps.browserVersion)});
        HashMap<String, Object> ltOptions = new HashMap<String, Object>();
        ltOptions.put("username", System.getenv("LT_USERNAME"));
        ltOptions.put("accessKey", System.getenv("LT_ACCESS_KEY"));
${lines}
        if (testName != null) ltOptions.put("name", testName);
        browserOptions.setCapability("LT:Options", ltOptions);
        return new RemoteWebDriver(new URL("${hub}"), browserOptions);`;
    snippet = body;
    const dir = (profile.projectRoot ? profile.projectRoot + "/" : "") + "src/test/java/" + (pkg ? pkg.replace(/\./g, "/") + "/" : "");
    helper = {
      path: dir + "LambdaTestDriverFactory.java",
      content: `${pkg ? `package ${pkg};\n\n` : ""}import java.net.URL;
import java.util.HashMap;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.${JAVA_PKG[optClass]}.${optClass};
import org.openqa.selenium.remote.RemoteWebDriver;

/**
 * Creates a WebDriver on the LambdaTest (TestMu AI) grid.
 * Credentials come from LT_USERNAME / LT_ACCESS_KEY, so whoever runs the tests uses their own account.
 * Generated by HyperExecute Studio.
 */
public final class LambdaTestDriverFactory {
    private LambdaTestDriverFactory() {}

    public static WebDriver create(String testName) throws Exception {
${body}
    }
}
`,
      usage: `WebDriver driver = LambdaTestDriverFactory.create("My test");`,
    };
  } else if (profile.language === "python") {
    language = "python";
    const lines = Object.entries(lt).filter(([k]) => k !== "platformName").map(([k, v]) => `    lt_options[${lit.python(k)}] = ${lit.python(v)}`).join("\n");
    const body = `    options = ${optClass}()
    options.browser_version = ${lit.python(caps.browserVersion)}
    options.platform_name = ${lit.python(lt.platformName)}
    lt_options = {}
    lt_options["username"] = os.environ.get("LT_USERNAME")
    lt_options["accessKey"] = os.environ.get("LT_ACCESS_KEY")
${lines}
    if test_name:
        lt_options["name"] = test_name
    options.set_capability("LT:Options", lt_options)
    return webdriver.Remote(command_executor="${hub}", options=options)`;
    snippet = body;
    const dir = profile.tests.files[0] ? path.posix.dirname(profile.tests.files[0]) + "/" : "";
    helper = {
      path: dir + "lambdatest_driver.py",
      content: `"""WebDriver on the LambdaTest (TestMu AI) grid. Credentials come from LT_USERNAME / LT_ACCESS_KEY.
Generated by HyperExecute Studio."""
import os

from selenium import webdriver
from selenium.webdriver import ${optClass}


def create_driver(test_name=None):
${body}
`,
      usage: `from lambdatest_driver import create_driver\ndriver = create_driver("My test")`,
    };
  } else if (profile.language === "csharp") {
    language = "csharp";
    const ns = (profile.tests.classes[0]?.className || "Tests").split(".").slice(0, -1).join(".") || "Tests";
    const lines = Object.entries(lt).filter(([k]) => k !== "platformName").map(([k, v]) => `            ltOptions.Add(${lit.csharp(k)}, ${lit.csharp(v)});`).join("\n");
    const body = `            var browserOptions = new ${optClass}();
            browserOptions.PlatformName = ${lit.csharp(lt.platformName)};
            browserOptions.BrowserVersion = ${lit.csharp(caps.browserVersion)};
            var ltOptions = new Dictionary<string, object>();
            ltOptions.Add("username", Environment.GetEnvironmentVariable("LT_USERNAME"));
            ltOptions.Add("accessKey", Environment.GetEnvironmentVariable("LT_ACCESS_KEY"));
${lines}
            if (testName != null) ltOptions.Add("name", testName);
            browserOptions.AddAdditionalOption("LT:Options", ltOptions);
            return new RemoteWebDriver(new Uri("${hub}"), browserOptions);`;
    snippet = body;
    const dir = profile.tests.classes[0] ? path.posix.dirname(profile.tests.classes[0].file) + "/" : "";
    helper = {
      path: dir + "LambdaTestDriverFactory.cs",
      content: `using System;
using System.Collections.Generic;
using OpenQA.Selenium;
using OpenQA.Selenium.${optClass.replace("Options", "") === "MicrosoftEdge" ? "Edge" : optClass.replace("Options", "")};
using OpenQA.Selenium.Remote;

namespace ${ns}
{
    /// <summary>WebDriver on the LambdaTest (TestMu AI) grid. Credentials come from LT_USERNAME / LT_ACCESS_KEY.
    /// Generated by HyperExecute Studio.</summary>
    public static class LambdaTestDriverFactory
    {
        public static IWebDriver Create(string testName = null)
        {
${body}
        }
    }
}
`,
      usage: `IWebDriver driver = LambdaTestDriverFactory.Create("My test");`,
    };
  } else if (profile.language === "node" && fw === "playwright") {
    language = "js";
    const pwCaps = { browserName: caps.browserName === "MicrosoftEdge" ? "MicrosoftEdge" : caps.browserName === "Safari" ? "pw-webkit" : caps.browserName, browserVersion: caps.browserVersion, "LT:Options": { platform: lt.platformName, build: lt.build, name: "My test", video: lt.video, network: lt.network, console: lt.console, tunnel: lt.tunnel, plugin: lt.plugin } };
    snippet = `const capabilities = ${JSON.stringify(pwCaps, null, 2)};`;
    helper = {
      path: (profile.packageRoot ? profile.packageRoot + "/" : "") + "lambdatest.connect.js",
      content: `// Connects Playwright to the LambdaTest (TestMu AI) cloud over CDP.
// Credentials come from LT_USERNAME / LT_ACCESS_KEY. Generated by HyperExecute Studio.
const { chromium } = require("playwright");

async function connect(testName = "Playwright test") {
  const capabilities = {
    browserName: ${JSON.stringify(pwCaps.browserName)},
    browserVersion: ${JSON.stringify(pwCaps.browserVersion)},
    "LT:Options": {
      platform: ${JSON.stringify(lt.platformName)},
      build: ${JSON.stringify(lt.build)},
      name: testName,
      user: process.env.LT_USERNAME,
      accessKey: process.env.LT_ACCESS_KEY,
      video: ${!!lt.video},
      network: ${!!lt.network},
      console: ${!!lt.console},
      tunnel: ${!!lt.tunnel},
    },
  };
  return chromium.connect(\`wss://cdp.lambdatest.com/playwright?capabilities=\${encodeURIComponent(JSON.stringify(capabilities))}\`);
}

module.exports = { connect };
`,
      usage: `const { connect } = require("./lambdatest.connect");\nconst browser = await connect("My test");`,
    };
  } else if (profile.language === "node" && fw === "webdriverio") {
    language = "js";
    const base = profile.configFile ? "./" + path.posix.basename(profile.configFile) : "./wdio.conf.js";
    snippet = JSON.stringify([caps], null, 2);
    helper = {
      path: (profile.packageRoot ? profile.packageRoot + "/" : "") + "wdio.lambdatest.conf.js",
      content: `// WebdriverIO config for the LambdaTest (TestMu AI) grid, extending the project's own config.
// Credentials come from LT_USERNAME / LT_ACCESS_KEY. Generated by HyperExecute Studio.
const { config: base } = require(${JSON.stringify(base)});

exports.config = {
  ...base,
  user: process.env.LT_USERNAME,
  key: process.env.LT_ACCESS_KEY,
  hostname: "hub.lambdatest.com",
  port: 443,
  protocol: "https",
  path: "/wd/hub",
  services: (base.services || []).filter((s) => !/chromedriver|selenium-standalone|devtools/.test(String(Array.isArray(s) ? s[0] : s))),
  maxInstances: 1,
  capabilities: ${JSON.stringify([caps], null, 2).replace(/\n/g, "\n  ")},
};
`,
      usage: `npx wdio run wdio.lambdatest.conf.js`,
    };
  } else {
    language = "js";
    const lines = Object.entries(lt).filter(([k]) => k !== "platformName").map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
    snippet = `const capabilities = ${JSON.stringify(caps, null, 2)};`;
    helper = {
      path: (profile.packageRoot ? profile.packageRoot + "/" : "") + "lambdatest.driver.js",
      content: `// selenium-webdriver on the LambdaTest (TestMu AI) grid. Credentials come from LT_USERNAME / LT_ACCESS_KEY.
// Generated by HyperExecute Studio.
const { Builder } = require("selenium-webdriver");

async function createDriver(testName) {
  const capabilities = {
    browserName: ${JSON.stringify(caps.browserName)},
    browserVersion: ${JSON.stringify(caps.browserVersion)},
    "LT:Options": {
      platformName: ${JSON.stringify(lt.platformName)},
      username: process.env.LT_USERNAME,
      accessKey: process.env.LT_ACCESS_KEY,
${lines}
      ...(testName ? { name: testName } : {}),
    },
  };
  return new Builder().usingServer("${hub}").withCapabilities(capabilities).build();
}

module.exports = { createDriver };
`,
      usage: `const { createDriver } = require("./lambdatest.driver");\nconst driver = await createDriver("My test");`,
    };
  }

  return {
    language,
    framework: fw,
    hub: hub === MOBILE_HUB ? hub : language === "js" && fw === "playwright" ? "wss://cdp.lambdatest.com/playwright" : hub,
    capabilities: caps,
    snippet,
    helper,
    notes: [
      "Credentials are read from LT_USERNAME / LT_ACCESS_KEY — the Studio's ▶ Run passes yours; on HyperExecute they come from the YAML env (secrets).",
      ...(lt.tunnel ? ["tunnel: true needs a running LambdaTest tunnel (set tunnel: true in the HyperExecute YAML too)."] : []),
      ...(hub === MOBILE_HUB ? ["Real devices: upload your .apk/.ipa to LambdaTest first (App Automation → upload, or the upload API) and put the returned lt://… id in \"app\". deviceName and platformVersion must match a device LambdaTest offers."] : []),
      "Point your existing driver creation at the helper (see Driver setup) — the Studio does not edit your test code for this.",
    ],
  };
}
