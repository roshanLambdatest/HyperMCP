# HyperExecute YAML MCP server

Reads a test-automation repo, detects its stack, and generates, validates and dry-runs a HyperExecute YAML. It uses a bundled knowledge base plus your live Confluence space (`HYP` on lambdatest.atlassian.net).

## Tools
| Tool | What it does |
|---|---|
| `analyze_repo` | Detects language, build tool, framework, test classes/methods/files/features/scenarios, tags/groups, env vars the code reads, grid/hub usage, reports, existing YAMLs |
| `generate_hyperexecute_yaml` | Builds the YAML: **v0.2** (native `framework:` runner) for Maven/Gradle TestNG/JUnit/Spock and .NET NUnit/MSTest, or **v0.1** (raw discovery) for everything else and for matrix mode (autosplit or matrix; split by class / method / suite / file / feature / scenario / tag; multi-OS; extra matrix axes; tunnel; secrets). `write: true` saves it to the repo |
| `validate_hyperexecute_yaml` | Lints v0.1 and v0.2 rules (including the v0.2 `testDiscovery` 0-tests trap), keys/typos, runson, `$test`, retries/timeouts, cache, hard-coded secrets, reports, and files referenced in the repo |
| `dry_run_test_discovery` | Runs the discovery command locally and shows what HyperExecute will split and how the first tasks expand |
| `search_knowledge_base` | Searches the bundled KB and Confluence together |
| `get_confluence_page` | Reads a full Confluence page (code/YAML blocks kept) |
| `knowledge_base_status` | Lists KB topics and tests the Confluence login |
| `scan_credentials_and_reporting` | Finds hard-coded LambdaTest usernames/access keys (masked) and integrations that report to the customer's side (TestRail, Jira/Xray, ReportPortal, Slack/Teams, email, Allure TestOps, Cypress Cloud, Percy/Applitools, other grids) |
| `fix_hardcoded_credentials` | Rewrites hard-coded credentials to read `LT_USERNAME` / `LT_ACCESS_KEY`. Dry run by default |
| `generate_lambdatest_capabilities` | LambdaTest grid connection code in the repo's language (`LT:Options`), using live browser/OS lists. Can write a helper file |
| `optimize_hyperexecute_yaml` | Ranked speed/cost/reliability suggestions for a YAML; applies the ones you pick |

Prompt: `create_hyperexecute_yaml` runs the whole workflow.

Supported: Java (Maven/Gradle), including TestNG, JUnit 4/5 and Cucumber · Node, including Playwright, Cypress, WebdriverIO, cucumber-js, Jest, Mocha, Nightwatch and TestCafe · Python, including pytest, Behave and Robot · .NET, including NUnit, xUnit, MSTest and SpecFlow.

## Setup
```bash
cd /Users/roshank/Downloads/hyperMCP && npm install && npm test
```

**VS Code (Copilot agent mode):** copy `examples/vscode-mcp.json` to `<your-automation-repo>/.vscode/mcp.json`, or add it to your user MCP config via *MCP: Open User Configuration*. Start the server from the file, and VS Code prompts once for your Atlassian email and token, then stores them encrypted.

**Claude Code (available in every repo):**
```bash
claude mcp add hyperexecute-yaml -s user -- npx -y github:roshanLambdatest/HyperMCP
# optional Confluence: add  -e ATLASSIAN_EMAIL=you@lambdatest.com -e ATLASSIAN_API_TOKEN=<token>  before the --
```
The server analyzes the folder Claude Code is running in. Needs Node.js 18+.

## Knowledge base
- **Bundled** (`knowledge/*.md`): YAML key reference, framework recipes, troubleshooting and a pre-sales checklist. Add your own `.md` or golden `.yaml` files here, or point `HE_KB_DIR` at a folder. They get indexed automatically.
- **Confluence** (live): set `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN`. The same Atlassian API token works for Jira and Confluence (create one at https://id.atlassian.com/manage-profile/security/api-tokens). Optional: `CONFLUENCE_BASE_URL`, `CONFLUENCE_SPACE` (comma-separated), and `ATLASSIAN_AUTH=bearer` for a Data Center PAT.

## Env
| Var | Default |
|---|---|
| `HE_DEFAULT_REPO` | cwd, i.e. the repo used when a tool gets no `repoPath` |
| `HE_KB_DIR` | extra knowledge folder |
| `CONFLUENCE_BASE_URL` | `https://lambdatest.atlassian.net/wiki` |
| `CONFLUENCE_SPACE` | `HYP` |

## Releasing the VS Code extension
1. Bump `version` in `vscode-extension/package.json` (e.g. `1.2.0`) and commit.
2. `git tag v1.2.0 && git push origin main --tags`
3. GitHub Actions runs the tests, builds `hyperexecute-yaml-studio.vsix`, and attaches it to the **v1.2.0** release.

Teammates install it from the Releases page: download the `.vsix`, then in the Extensions view choose `⋯` → **Install from VSIX…**, then run **Developer: Reload Window**.
