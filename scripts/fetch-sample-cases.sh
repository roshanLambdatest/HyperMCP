#!/usr/bin/env bash
# Builds accuracy cases from LambdaTest's public sample repos (github.com/LambdaTest), whose YAMLs are the reference.
#   scripts/fetch-sample-cases.sh [dir]        default ~/he-accuracy-cases
#   HE_ACCURACY_CASES=<dir> npm run accuracy
set -euo pipefail
DIR="${1:-$HOME/he-accuracy-cases}"
mkdir -p "$DIR/_repos"
while read -r name repo yaml ignore why; do
  base="${repo%%/*}"
  [ -d "$DIR/_repos/$base" ] || git clone -q --depth 1 "https://github.com/LambdaTest/$base.git" "$DIR/_repos/$base"
  mkdir -p "$DIR/$name"
  cp "$DIR/_repos/$repo/$yaml" "$DIR/$name/expected.yaml"
  extra=""
  [ "$ignore" != "-" ] && extra=", \"ignore\": [\"${ignore//_/ }\"], \"why\": \"${why//_/ }\""
  printf '{ "name": "%s", "repo": "../_repos/%s", "source": "https://github.com/LambdaTest/%s/blob/HEAD/%s"%s }\n' "$name" "$repo" "$base" "$yaml" "$extra" > "$DIR/$name/case.json"
done <<'CASES'
testng-v1-autosplit testng-selenium-hyperexecute-sample yaml/linux/v1/testng_hyperexecute_autosplit_sample.yaml - -
testng-v2-autosplit testng-selenium-hyperexecute-sample yaml/mac/v2/testng_hyperexecute_autosplit_sample.yaml - -
junit-autosplit junit-selenium-hyperexecute-sample yaml/linux/junit_hyperexecute_autosplit_sample.yaml - -
cucumber-java-autosplit cucumber-selenium-hyperexecute-sample yaml/linux/cucumber_hyperexecute_autosplit_sample.yaml - -
robot-autosplit robot-selenium-hyperexecute-sample yaml/linux/robot_hyperexecute_autosplit_sample.yaml - -
pytest-autosplit pytest-selenium-hyperexecute-sample yaml/linux/pytest_hyperexecute_autosplit_sample.yaml - -
behave-autosplit behave-selenium-hyperexecute-sample yaml/linux/behave_hyperexecute_autosplit_sample.yaml - -
nunit-autosplit nunit-selenium-hyperexecute-sample yaml/linux/nunit_hyperexecute_autosplit_sample.yaml - -
nunit-v2 nunit-selenium-hyperexecute-sample yaml/linux/nunit_hyperexecute_remote_v2.yaml - -
specflow-autosplit specflow-selenium-hyperexecute-sample yaml/linux/specflow_hyperexecute_autosplit_sample.yaml - -
reqnroll-autosplit reqnroll-hyperexecute-sample/selenium_4 yaml/linux/reqnroll_hyperexecute_autosplit_sample.yaml - -
wdio-cucumber-autosplit WebdriverIO-Cucumber-HyperExecute-Sample yaml/linux/webdriverIO_hyperexecute_autosplit_sample.yaml - -
wdio-linux WebdriverIO-HyperExecute-Sample yaml/linux/hyperexecute-webdriver-linux.yaml - -
nightwatch-autosplit Hyperexecute-Nightwatch-Sample yaml/linux/nightwatch_hyperexecute_autosplit_sample.yaml discovered_count The_sample_splits_by_nightwatch_environment,_not_by_test_file.
playwright-jest-autosplit HyperExecute-Playwright-Jest yaml/linux/.hyperexecute_autosplits.yaml - -
playwright-vanilla-autosplit HyperExecute-Playwright-Vanilla-Javascript yaml/linux/.hyperexecute_autosplits.yaml - -
playwright-ts-autosplit Playwright-Hyperexecute-Typescript-sample autosplit.yaml - -
cypress-v15-autosplit hyperexecute-cypress-v15-sample yaml/linux/.hyperexecute_autosplit.yaml discovered_count The_sample_only_runs_cypress/e2e/2-advanced-examples.
cypress-v9-autosplit hyperexecute-cypress-v9-sample yaml/linux/.hyperexecute_autosplit.yaml - -
java-playwright-junit-autosplit hyperexecute-java-playwright-sample yaml/linux/junit_hyperexecute_autosplit_sample.yaml - -
playwright-python-autosplit hyperexecute-playwright-python-sample yaml/linux/.hyperexecute_autosplits.yaml - -
gradle-testng hyperexecute-selenium-gradle-testng-sample hyperexecute-linux.yaml - -
spock hyperexecute-spock-sample hyperexecute.yaml discovered_count The_sample_repeats_one_Gradle_task_per_VM.
CASES
echo "Cases in $DIR. Run: HE_ACCURACY_CASES=$DIR npm run accuracy"
