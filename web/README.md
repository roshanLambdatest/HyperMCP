# HyperExecute Studio — web version

A static web page for external customers: no IDE, no install, no account needed to build a YAML.

**Everything runs in the visitor's browser.** The repo they pick (folder, drag-and-drop, .zip, or a built-in sample) is read into an in-memory filesystem, and the same core as the MCP server and VS Code extension (`../src`) analyzes it. Network calls go only to `api.lambdatest.com` (live browser/OS lists, optional account check), GitHub (only when importing a public repo by URL) and, if the visitor turns Claude on, `api.anthropic.com`. Claude's code is a separate file, downloaded only then. The page's Content-Security-Policy blocks anything else.

| Works in the browser | Not available (needs a real machine) |
|---|---|
| Chat assistant that drives the whole setup, with answers from a customer-safe knowledge base | Local dry-run of the discovery command (the Run tab shows the command to run) |
| Analysis with confidence, assumptions and questions | Starting and watching jobs (the Run tab gives the CLI download and commands) |
| YAML generation (v0.1 / v0.2), option bar, syntax-highlighted editor | Internal material (Confluence, pre-sales checklist): left out of the build |
| Validation while editing, Download / Copy, Undo; checks the repo's existing YAML | Fetching job logs by job ID (HyperExecute's API refuses browser calls; paste the log instead) |
| Optimize suggestions; CI pipeline files (GitHub Actions, GitLab, Jenkins, Azure DevOps) | |
| Credential & reporting scan, fixed files as .zip | |
| Log diagnosis with a corrected YAML (paste in chat or the Diagnose tab) | |
| LambdaTest grid capabilities (live lists), Appium real devices | |
| Import a public GitHub repo by URL; share a setup as a link (options only, never code) | |
| Usual settings remembered per framework; Report a problem (prepared GitHub issue) | |

## Chat

The left pane is a chat that drives everything. The **built-in assistant** needs no AI and no key. It turns plain requests into YAML options ("Windows 11, 10 VMs, split by scenario, add a tunnel", "Chrome and Firefox", "only @smoke", "BASE_URL=https://…"), explains the YAML, says whether it's valid, optimizes it, answers common HyperExecute questions, diagnoses a pasted job log, and can undo.

**Claude (optional).** A visitor can add their own Anthropic API key in Settings to also ask anything in plain words. The page calls Claude Opus 5.5 directly from the browser with the official SDK, JSON-schema output and the default refusal fallback. It sends the question, the YAML and a summary of the repo, never source files. The key lives in the tab's memory only.

## Build and preview

```bash
cd web
npm ci
npm run build     # → dist/ (index.html, app.css, app.js, fonts/ — minified and obfuscated)
npm run serve     # → http://localhost:4321
node test/e2e.js  # real Chrome: parity with the Node core, chat, Claude request shape (mocked), tabs, samples, phone, CSP, network
```

`npm run build:dev` builds a readable version with a source map for debugging.

## Hosting

`dist/` is a handful of static files. Put them on any static host (an internal CDN, S3 + CloudFront, Netlify, GitHub Pages from a repo the customers may see). No server-side code, no environment variables, no data stored.
