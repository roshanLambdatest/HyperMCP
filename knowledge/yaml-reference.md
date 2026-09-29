# HyperExecute YAML reference

Source: https://www.lambdatest.com/support/docs/deep-dive-into-hyperexecute-yaml/ (checked 2026-09-30). Confirm edge cases against the live docs or the HYP Confluence space.

## Mandatory keys
- `version`: `0.1` (or `0.2`).
- `runson`: `linux` | `mac` | `mac13` | `win` | `win11`, or `${matrix.os}` for multi-OS matrix jobs.
- `pre`: list of commands that install dependencies on every VM (e.g. `mvn ... clean install -Dmaven.test.skip=true`, `npm ci`, `pip3 install -r requirements.txt`).

## Execution modes
- **Autosplit** (`autosplit: true`): HyperExecute runs `testDiscovery.command`, takes each output line as one test, and spreads them across `concurrency` VMs using `testRunnerCommand` with `$test` substituted. Best default — it load-balances on historical durations.
- **Matrix** (`matrix:` + `testSuites:`): every combination of matrix values becomes a task. Values are referenced as `$<key>` in `testSuites` and are also exposed as env vars. Use for explicit lists, tags/groups, cross-browser or multi-OS runs. `runson: ${matrix.os}` + `matrix.os: [linux, win]`.
- **Hybrid**: matrix + autosplit together (e.g. matrix of OS × autosplit of tests).
- `concurrency`: number of parallel VMs. `parallelism`: tasks per matrix combination (`linuxParallelism`, `winParallelism`, `macParallelism`).

## testDiscovery
```yaml
testDiscovery:
  type: raw          # raw | automatic
  mode: remote       # local = run on the machine running the CLI; remote = run on a HyperExecute VM
  command: grep -rlE --include='*.java' '@Test' src/test/java | sed -E 's#^.*src/test/java/##; s#\.java$##; s#/#.#g'
testRunnerCommand: mvn test -Dmaven.repo.local=$CACHE_DIR -Dtest="$test"
```
- The command must print one test identifier per line — nothing else.
- `static`/`dynamic` are legacy names for the mode; current docs use `local`/`remote`.
- OS-specific runners: `linuxTestRunnerCommand`, `macTestRunnerCommand`, `winTestRunnerCommand`.
- Windows VMs: bash utilities (grep/sed/awk) are safest with `mode: local` (discovery runs on your Mac/Linux/CI box).

## Dependencies, caching, runtime
```yaml
runtime:
  language: java      # java | maven | node | python | ruby | dotnet | android-sdk | katalon
  version: "17"
env:
  CACHE_DIR: m2_cache_dir
cacheKey: '{{ checksum "pom.xml" }}'
cacheDirectories:
  - $CACHE_DIR
```
- Cache is keyed on the checksum of the file — changes to the dependency file invalidate it.
- Maven: always pass `-Dmaven.repo.local=$CACHE_DIR` in both `pre` and the runner so the cache is used.
- Node: cache `node_modules`, key on the lockfile. Python: `pip3 install ... --cache-dir pip_cache`, cache `pip_cache`.

## Environment variables and secrets
```yaml
env:
  BASE_URL: https://staging.example.com
  LT_ACCESS_KEY: ${{ .secrets.LT_ACCESS_KEY }}
```
- Never hard-code keys/passwords — create them under HyperExecute → Settings → Secrets and reference with `${{ .secrets.NAME }}`.
- `vars` holds non-env variables; `dataJsonPath` / `dataJsonBuilder` drive data-driven runs.

## Retries, fail-fast, timeouts
- `retryOnFailure: true` + `maxRetries: 1..5`.
- `retryOptions.errorRegexps: ["NoSuchElementException"]` — only retry on matching errors.
- `failFast: { maxNumberOfTests: 2, level: scenario }` — abort early after N failures.
- `globalTimeout` (1-150 min, whole job), `testSuiteTimeout` (per task, min), `testSuiteStep` (per step, min).

## Reports and artefacts
```yaml
mergeArtifacts: true
uploadArtefacts:
  - name: Reports
    path:
      - target/surefire-reports/**
report: true
partialReports:
  location: target/surefire-reports/html
  type: html          # html | json | xml
  frameworkName: testng
```
- Documented `frameworkName` values: `testng`, `junit`, `cucumber`, `extent`, `extent-native` (report types listed in docs also include Allure, Playwright HTML, SpecFlow, Cypress Mochawesome, Karate, Robot, Katalon — confirm the exact frameworkName in docs/Confluence).
- Cucumber: `location: reports/**/cucumber/`, `type: json`, `frameworkName: cucumber` — requires the Cucumber `json:` plugin.
- Extent native: `location: reports/json`, `type: json`, `frameworkName: extent-native`.
- Key is spelled `uploadArtefacts` (British), while `mergeArtifacts` uses American spelling.
- `errorCategorizedReport: { enabled: true }` groups failures by error type.

## Network
- `tunnel: true` starts a LambdaTest tunnel for internal/staging URLs; `tunnelOpts` (args, global, systemProxy), `tunnelNames` to reuse an existing tunnel.
- `hostsOverride: [{host: app.local, ip: 10.0.0.5}]`.

## Other useful keys
- `jobLabel: [smoke, linux, high]` — labels (high/medium/low act as priority).
- `project: {name: ..., id: ...}`, `buildConfig: {buildName: ...}`.
- `background` / `backgroundDirectives` — start a server (e.g. the app under test) before tests.
- `globalPre` / `globalPost` — run once per job instead of per VM.
- `preDirectives: {commands: [...], maxRetries: 1}` — retrying pre-steps.
- `differentialUpload: {enabled: true, ttlHours: 60}` — upload only changed files.
- `base: {yamls: [./base.yaml]}` — inherit from a shared YAML.
- `cypress: true` + `cypressOps` — native Cypress mode.
- `captureScreenRecordingForScenarios: true`.

## Running the job
```bash
# download CLI: https://www.lambdatest.com/support/docs/hyperexecute-cli-run-tests-on-hyperexecute-grid/
./hyperexecute --user "$LT_USERNAME" --key "$LT_ACCESS_KEY" --config hyperexecute.yaml
# useful flags: --download-artifacts, --verbose, --force-clean-artifacts
```

## YAML v0.2 — framework field (native discovery)
Source: Confluence HYP "Yaml version 0.2" (3469344845), "Java runners" (5222203394), ".NET runners" (5222367259). Always check Confluence for the latest.
- Replaces `testDiscovery` + `testRunnerCommand` with `framework:`. Needs `version: "0.2"` and `autosplit: true`. Matrix mode is not supported.
- **Trap:** a v0.2 YAML must NOT contain `testDiscovery:`. It silently routes to the v0.1 path, and the job "completes" with 0 tests.
- Runners: `maven/testng`, `maven/junit4`, `maven/junit5` (local default, or remote), `maven/spock`, `gradle/testng`, `gradle/junit4|junit5|junit6|spock`, `dotnet/nunit`, `dotnet/mstest` (remote only; `local` is rejected).
- `discoveryType`: `method` (default), `class` (class-atomic), `xmltest` (one unit per `<test>` in a TestNG suite XML; TestNG only).
- `baseCommand`: full command replacing `mvn test` / `gradle test`, e.g. `./gradlew integrationTest`. It must start with the build tool, never a bare task.
- `flags` (discovery + execution), `discoveryFlags` (e.g. `-Dgroups=smoke` to discover only a TestNG group or JUnit tag), `runnerFlags`, `workingDirectory`.
- `defaultReports` defaults to false and must not be true together with `report: true`.
- Caching is automatic (`~/.m2`, `~/.gradle/caches`, `~/.nuget/packages`). Setting both `cacheKey` and `cacheDirectories` disables it.
- Gradle: 7.0+, JDK 8+, java plugin (groovy for Spock). The plugin is injected via an init script, with no build.gradle change.
- .NET: `pre` must build (`dotnet build -c Release`). If there are several csproj files, pass `flags: [--project, Tests/X.csproj]`. If both Debug and Release are built, pass `--assembly <dll>`. Needs net5.0+ (EOL runtimes are refused with UNSUPPORTED_TFM_OR_RUNTIME). Selenium: `idleTimeout: 900`. Playwright CDP on win/mac: `npm install playwright@<Microsoft.Playwright version> --save-exact` in pre.

```yaml
---
version: "0.2"
runson: linux
autosplit: true
concurrency: 4
retryOnFailure: true
maxRetries: 1
pre:
  - mvn dependency:resolve
framework:
  name: maven/testng
  discoveryMode: remote
  discoveryType: class
  flags: ["-Dplatname=linux"]
```
