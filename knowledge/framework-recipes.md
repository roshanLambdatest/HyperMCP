# Framework recipes

Starting points per framework. The generator uses these; tweak for the customer's repo.

## Java Maven TestNG / JUnit (class-level autosplit)
```yaml
env:
  CACHE_DIR: m2_cache_dir
cacheKey: '{{ checksum "pom.xml" }}'
cacheDirectories: [$CACHE_DIR]
pre:
  - mvn -Dmaven.repo.local=$CACHE_DIR -Dmaven.test.skip=true clean install
testDiscovery:
  type: raw
  mode: remote
  command: grep -rlE --include='*.java' '@Test' src/test/java | sed -E 's#^.*src/test/java/##; s#\.java$##; s#/#.#g'
testRunnerCommand: mvn test -Dmaven.repo.local=$CACHE_DIR -DfailIfNoTests=false -Dtest="$test"
```
- Method-level: discovery prints `pkg.Class#method`; runner is the same `-Dtest="$test"`.
- `-Dtest` overrides `<suiteXmlFiles>`, so suite-level `<parameter>` values and listeners in testng.xml are NOT applied. If the suite XML carries browser/platform parameters, either split by suite (`-DsuiteXmlFile=$test` with `<suiteXmlFile>${suiteXmlFile}</suiteXmlFile>` in the pom) or move the parameters to `-D` system properties / env vars.
- TestNG groups / JUnit 5 tags: matrix on `-Dgroups="$tag"`.
- Gradle: `./gradlew test --tests "$test"` (method separator is `.`), cache `GRADLE_USER_HOME`.

## Java Cucumber
- Feature split: `find src/test/resources -name '*.feature'` → `mvn test -Dtest=RunnerClass -Dcucumber.features="$test"`.
- Scenario split: `grep -rnE '^\s*Scenario( Outline)?:' ... | awk -F: '{print $1":"$2}'` → same runner with `path:line`.
- Tag split (matrix): `-Dcucumber.filter.tags="$tag"`. Cucumber < 5 uses `-Dcucumber.options="--tags @x"`.
- Add `plugin = {"json:target/cucumber-reports/cucumber.json"}` to the runner for HyperExecute's Cucumber report.
- `-Dtest=<Runner>` is important: without it surefire also runs every other test class.

## Playwright (Node)
```yaml
pre:
  - npm ci
  - npx playwright install
cacheKey: '{{ checksum "package-lock.json" }}'
cacheDirectories: [node_modules]
testDiscovery:
  type: raw
  mode: remote
  command: find tests -type f -name '*.spec.*' | sed 's#^\./##'
testRunnerCommand: npx playwright test "$test"
uploadArtefacts:
  - name: PlaywrightReport
    path: [playwright-report/**, test-results/**]
```
- Set `workers: 1` (or low) in playwright.config for HyperExecute; parallelism comes from `concurrency`.

## Cypress
- `npx cypress run --spec "$test"`, discovery `find cypress/e2e -name '*.cy.*'`.
- Native mode: `cypress: true` with `cypressOps` (Build, Tags, Network, FullHar, geoLocation, reporterConfigFile, ProjectName).
- Upload `cypress/videos/**`, `cypress/screenshots/**`, mochawesome output.

## WebdriverIO
- `npx wdio run wdio.conf.js --spec "$test"`; set `maxInstances: 1` on HyperExecute.
- If wdio.conf points at `hub.lambdatest.com`, tests still run from HyperExecute VMs against the grid; for local browsers on the VM remove the hostname/services config.

## pytest
```yaml
pre:
  - pip3 install -r requirements.txt --cache-dir pip_cache
cacheKey: '{{ checksum "requirements.txt" }}'
cacheDirectories: [pip_cache]
testDiscovery:
  type: raw
  mode: remote
  command: find . -type f -name 'test_*.py' -not -path '*/venv/*' | sed 's#^\./##'
testRunnerCommand: python3 -m pytest "$test" --junitxml=reports/junit-$RANDOM.xml
report: true
partialReports:
  location: reports/
  type: xml
  frameworkName: junit
```
- Don't use pytest-xdist `-n` on HyperExecute.
- Windows VMs: use `python` instead of `python3`.
- Markers: matrix on `-m "$tag"`.

## Behave / Robot
- Behave: `python3 -m behave "$test"` per feature or `feature:line` scenario, tags `--tags=$tag`.
- Robot: `python3 -m robot --outputdir robot-results "$test"` per .robot file, tags `--include`.

## .NET (NUnit / xUnit / MSTest / SpecFlow)
```yaml
env:
  NUGET_PACKAGES: nuget_cache
pre:
  - dotnet restore
  - dotnet build --no-restore
testRunnerCommand: dotnet test --no-build --filter "FullyQualifiedName~$test." --logger "trx;LogFileName=results-$RANDOM.trx" --results-directory TestResults
```
- Trailing `.` in the filter prevents `LoginTests` also matching `LoginTestsExtra`.
- SpecFlow/Reqnroll: split by tags (`--filter "TestCategory=$tag"`), since scenario classes are generated at build time.
- Many .NET customers run on `runson: win`.

## Appium / mobile
- App tests on real devices use the LambdaTest App Automation hub (`mobile-hub.lambdatest.com`) from the HyperExecute VM; upload the app beforehand (lt://APP id) and pass it via env/secrets.
- Keep concurrency within the customer's real-device concurrency.
