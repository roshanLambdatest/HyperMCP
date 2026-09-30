// CI pipeline files that run a HyperExecute YAML from the customer's own CI:
// GitHub Actions, GitLab CI, Jenkins, Azure DevOps. The CLI runs on the CI machine; the tests run on
// HyperExecute VMs. LT_USERNAME / LT_ACCESS_KEY come from the CI's secret store, never from the file.
//
// When the YAML uses ${{ .secrets.LT_* }} references, a step fills them into a copy for the run (same idea
// as credentials.runtimeConfig), so no HyperExecute portal secrets are needed either. The sed pattern
// never contains the literal "${{", which GitHub Actions and Azure would try to expand themselves.

const CLI_URL = "https://downloads.lambdatest.com/hyperexecute/linux/hyperexecute";

export const CI_SYSTEMS = {
  github: { name: "GitHub Actions", path: ".github/workflows/hyperexecute.yml" },
  gitlab: { name: "GitLab CI", path: ".gitlab-ci.yml" },
  jenkins: { name: "Jenkins", path: "Jenkinsfile" },
  azure: { name: "Azure DevOps", path: "azure-pipelines.yml" },
};

const usesSecretRefs = (yaml) => /\$\{\{\s*\.secrets\.LT_(USERNAME|ACCESS_KEY)\s*\}\}/.test(yaml || "");
// the account typed straight into the YAML (embedded credentials) must not end up in a committed CI run
const hasLiteralKey = (yaml) => /^\s*LT_ACCESS_KEY:\s*(?!\$\{\{|<set |["']?\$)\S+/m.test(yaml || "");

// POSIX shell lines shared by every system
function shellSteps(config, fill) {
  const run = fill ? ".hyperexecute-ci.yaml" : config;
  const fillLine = `sed -e 's|\\$[{][{] *\\.secrets\\.LT_USERNAME *[}][}]|'"$LT_USERNAME"'|g' -e 's|\\$[{][{] *\\.secrets\\.LT_ACCESS_KEY *[}][}]|'"$LT_ACCESS_KEY"'|g' ${config} > ${run}`;
  return {
    download: `curl -fsSL -o hyperexecute ${CLI_URL} && chmod +x hyperexecute`,
    fill: fill ? fillLine : null,
    run: `./hyperexecute --user "$LT_USERNAME" --key "$LT_ACCESS_KEY" --config ${run} --download-logs`,
  };
}

export function generatePipeline({ ci = "github", configFile = "hyperexecute.yaml", yaml = "", branch = "main" } = {}) {
  const sys = CI_SYSTEMS[ci];
  if (!sys) throw new Error(`Unknown CI "${ci}". Choose one of: ${Object.keys(CI_SYSTEMS).join(", ")}.`);
  const fill = usesSecretRefs(yaml);
  const s = shellSteps(configFile, fill);
  const notes = [];
  let content;

  if (ci === "github") {
    content = `name: HyperExecute
on:
  workflow_dispatch:
  push:
    branches: [${branch}]

jobs:
  hyperexecute:
    runs-on: ubuntu-latest
    timeout-minutes: 180
    steps:
      - uses: actions/checkout@v7
      - name: Download the HyperExecute CLI
        run: ${s.download}
${fill ? `      - name: Fill the LambdaTest account into a copy of the YAML
        env:
          LT_USERNAME: \${{ secrets.LT_USERNAME }}
          LT_ACCESS_KEY: \${{ secrets.LT_ACCESS_KEY }}
        run: ${s.fill}
` : ""}      - name: Run the tests on HyperExecute
        env:
          LT_USERNAME: \${{ secrets.LT_USERNAME }}
          LT_ACCESS_KEY: \${{ secrets.LT_ACCESS_KEY }}
        run: ${s.run}
      - name: Keep the job logs
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: hyperexecute-logs
          path: hyperexecute-logs/
          if-no-files-found: ignore
`;
    notes.push("Add LT_USERNAME and LT_ACCESS_KEY under the repo's Settings → Secrets and variables → Actions.");
  } else if (ci === "gitlab") {
    content = `hyperexecute:
  image: ubuntu:24.04
  timeout: 3h
  rules:
    - if: $CI_COMMIT_BRANCH == "${branch}"
    - when: manual
  before_script:
    - apt-get update -qq && apt-get install -y -qq curl ca-certificates
  script:
    - ${s.download}
${fill ? `    - ${s.fill}\n` : ""}    - ${s.run}
  artifacts:
    when: always
    paths:
      - hyperexecute-logs/
`;
    notes.push("Add LT_USERNAME and LT_ACCESS_KEY under Settings → CI/CD → Variables, with Masked and Protected on.");
  } else if (ci === "jenkins") {
    // Groovy ''' strings keep $ literal and turn \\ into \, so the shell sees exactly the lines above
    const g = (line) => line.replace(/\\/g, "\\\\");
    content = `pipeline {
  agent any
  options { timeout(time: 3, unit: 'HOURS') }
  environment {
    LT_USERNAME   = credentials('lt-username')
    LT_ACCESS_KEY = credentials('lt-access-key')
  }
  stages {
    stage('HyperExecute') {
      steps {
        sh '''
          ${g(s.download)}
${fill ? `          ${g(s.fill)}\n` : ""}          ${g(s.run)}
        '''
      }
    }
  }
  post {
    always { archiveArtifacts artifacts: 'hyperexecute-logs/**', allowEmptyArchive: true }
  }
}
`;
    notes.push("Create two Jenkins credentials of kind Secret text, with IDs lt-username and lt-access-key. The agent needs curl and a Linux shell.");
  } else {
    content = `trigger:
  branches:
    include: [${branch}]

pool:
  vmImage: ubuntu-latest

steps:
  - checkout: self
  - script: ${s.download}
    displayName: Download the HyperExecute CLI
${fill ? `  - script: ${s.fill}
    displayName: Fill the LambdaTest account into a copy of the YAML
    env:
      LT_USERNAME: $(LT_USERNAME)
      LT_ACCESS_KEY: $(LT_ACCESS_KEY)
` : ""}  - script: ${s.run}
    displayName: Run the tests on HyperExecute
    timeoutInMinutes: 180
    env:
      LT_USERNAME: $(LT_USERNAME)
      LT_ACCESS_KEY: $(LT_ACCESS_KEY)
  - publish: hyperexecute-logs
    artifact: hyperexecute-logs
    condition: always()
    continueOnError: true
`;
    notes.push("Add LT_USERNAME and LT_ACCESS_KEY as pipeline variables and mark LT_ACCESS_KEY as secret.");
  }

  if (fill) notes.push("The YAML uses ${{ .secrets.LT_* }} references; the pipeline fills them from the CI secrets into a temporary copy, so no HyperExecute portal secrets are needed.");
  if (hasLiteralKey(yaml)) notes.push("Warning: this YAML contains a LambdaTest access key in plain text. For CI, rebuild it with secret references (turn off \"put my account into the YAML\") before committing.");
  notes.push("The CLI exits non-zero when the job fails, so the pipeline fails with it. Job logs are kept as a build artifact.");
  return { ci, name: sys.name, path: sys.path, content, notes };
}
