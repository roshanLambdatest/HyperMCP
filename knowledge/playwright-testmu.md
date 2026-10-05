# Playwright on the LambdaTest (TestMu AI) cloud

From LambdaTest's playwright-skill (github.com/LambdaTest/agent-skills, MIT), the parts that matter when setting up HyperExecute. Use it to recognize how a repo connects to the cloud and what its YAML must keep.

## How a repo connects: three patterns

| Pattern | What you see in the repo | YAML impact |
|---|---|---|
| 1. Direct connect | `chromium.connect({ wsEndpoint: "wss://cdp.lambdatest.com/playwright?capabilities=…" })` in a script or setup file | Tests read `LT_USERNAME` / `LT_ACCESS_KEY`: keep them in `env` as `${{ .secrets.* }}` |
| 2. Fixture + `@lambdatest` projects (recommended) | `lambdatest-setup.ts` extending `test` with a `page` fixture; projects named `browserName:version:platform@lambdatest` in `playwright.config` | Tests import `test` from the fixture. Run cloud projects with `--project="chrome:latest:Windows 11@lambdatest"` (quote it: the name has spaces). Projects without `@lambdatest` run locally on the VM |
| 3. Playwright SDK (no code changes) | `playwright-node-sdk` in devDependencies and a `lambdatest.yml` (user, key, platforms, playwrightConfigOptions) | Command is `npx playwright-node-sdk playwright test`; browsers and OS come from `lambdatest.yml`, not the HyperExecute matrix |

Pattern 2's project name parses as `browserName:version:platform@lambdatest`, e.g. `chrome:latest:Windows 11@lambdatest`, `MicrosoftEdge:latest:macOS Sonoma@lambdatest`, `pw-webkit:latest:macOS Ventura@lambdatest`.

## Capabilities

```js
const capabilities = {
  browserName: "Chrome",            // Chrome | MicrosoftEdge | pw-chromium | pw-firefox | pw-webkit
  browserVersion: "latest",
  "LT:Options": {
    platform: "Windows 11",
    build: "Playwright Build",
    name: "Playwright Test",
    user: process.env.LT_USERNAME,  // Playwright uses "user", Selenium uses "username"
    accessKey: process.env.LT_ACCESS_KEY,
    network: true, video: true, console: true,
    playwrightClientVersion: "<npx playwright --version>",
  },
};
```

- Safari and Firefox on the cloud are Playwright builds: `pw-webkit`, `pw-firefox` (not "Safari" / "Firefox").
- Endpoint: `wss://cdp.lambdatest.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(capabilities))}`.
- `playwrightClientVersion`: the repo's Playwright version (the fixture reads it from `npx playwright --version`).

## Test status on the dashboard

Cloud sessions show "Completed" unless the test reports its result. In `afterEach` (pattern 2's fixture does this):

```js
await page.evaluate((_) => {}, `lambdatest_action: ${JSON.stringify({ action: "setTestStatus", arguments: { status: testInfo.status, remark: testInfo.error?.message || "OK" } })}`);
```

If every session on the dashboard says "Completed", the tests don't report status yet.

## On HyperExecute

- Parallelism comes from HyperExecute `concurrency`: set `workers: 1` (or low) in `playwright.config`.
- Run a subset of cloud projects: `npx playwright test --grep @smoke --project="chrome:latest:Windows 11@lambdatest"`.
- Cloud projects (`@lambdatest`) run the browser on LambdaTest; `npx playwright install` in `pre` is for projects that launch a browser on the VM.
- Reports: `playwright-report/**` and `test-results/**` as artefacts; traces with `trace: 'on-first-retry'` (`npx playwright show-trace trace.zip`).

## Flaky tests: checklist (first match wins)

1. `waitForTimeout` → `await expect(locator).toBeVisible()` or `page.waitForResponse()`.
2. `expect(await locator.isVisible())` → `await expect(locator).toBeVisible()` (auto-retries).
3. `page.$()` / CSS / XPath → `getByRole`, `getByLabel`, `getByTestId`.
4. Shared state between tests → set up in `test.beforeEach`; tests must be independent (they run on different VMs).
5. Click that navigates without `await page.waitForURL(...)`.
6. Dialog handler registered after the action that opens it.
7. Animations → `animations: 'disabled'`.
8. Network races → `page.waitForResponse()` or mock with `page.route()`.
9. Time-dependent tests → mock `Date.now()` with `page.addInitScript`.
