#!/usr/bin/env node
// Simulated HyperExecute CLI that produces per-test JUnit results in the artifacts folder.
// invalidLogin needs tunnel: true; forgotPassword needs env PAYMENT_API_URL;
// validLogin (assertion) and logout (locator) always fail — they are "code" problems.
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const cfgPath = opt("--config") || "hyperexecute.yaml";
const cfg = fs.readFileSync(cfgPath, "utf8");
console.log(`config=${path.basename(cfgPath)} injected=${!!process.env.LT_ACCESS_KEY && cfg.includes(process.env.LT_ACCESS_KEY) && !cfg.includes(".secrets.LT_ACCESS_KEY")}`);
fs.writeFileSync(".fake-last-config", path.basename(cfgPath) + " " + (cfg.includes(process.env.LT_ACCESS_KEY || "@@none@@") ? "filled" : "plain"));
const out = opt("--download-artifacts-path") || "artifacts";
const run = Number(fs.existsSync(".fake-runs") ? fs.readFileSync(".fake-runs", "utf8") : 0) + 1;
fs.writeFileSync(".fake-runs", String(run));
console.log(`Job Link: https://hyperexecute.lambdatest.com/hyperexecute/task?jobId=00000000-0000-0000-0000-00000000000${run}`);
const all = ["validLogin", "invalidLogin", "forgotPassword", "logout"];
const only = (cfg.match(/printf '%s\\n' (.+)/) || [])[1];
const selected = only ? all.filter((m) => only.includes(`LoginTest#${m}`)) : all;
const tunnel = /^tunnel: true/m.test(cfg);
const payment = /PAYMENT_API_URL: \S+/.test(cfg);
const result = {
  validLogin: `<failure message="expected [Dashboard] but found [Login]" type="java.lang.AssertionError">java.lang.AssertionError: expected [Dashboard] but found [Login]</failure>`,
  invalidLogin: tunnel ? "" : `<error message="unknown error: net::ERR_NAME_NOT_RESOLVED" type="org.openqa.selenium.WebDriverException">WebDriverException: net::ERR_NAME_NOT_RESOLVED https://staging.acme.internal</error>`,
  forgotPassword: payment ? "" : `<error message="Cannot invoke &quot;String.isEmpty()&quot; because the return value of &quot;java.lang.System.getenv(String)&quot; is null" type="java.lang.NullPointerException">NullPointerException at BaseTest.java:12 System.getenv("PAYMENT_API_URL")</error>`,
  logout: `<failure message="no such element: Unable to locate element #logout" type="org.openqa.selenium.NoSuchElementException"/>`,
};
fs.mkdirSync(path.join(out, "task-1", "target", "surefire-reports"), { recursive: true });
const cases = selected.map((m) => `<testcase classname="com.acme.tests.LoginTest" name="${m}">${result[m]}</testcase>`).join("\n");
fs.writeFileSync(path.join(out, "task-1", "target", "surefire-reports", "TEST-com.acme.tests.LoginTest.xml"), `<testsuite name="LoginTest">\n${cases}\n</testsuite>`);
const failed = selected.filter((m) => result[m]);
console.log(`Tests run: ${selected.length}, Failures: ${failed.length}`);
process.exit(failed.length ? 1 : 0);
