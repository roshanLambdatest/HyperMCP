# HyperExecute YAML Studio

A docked side-bar view (like Claude Code) for building HyperExecute YAMLs from the repo you have open. It never takes over your editor. Drag the ⚡ icon to the Secondary Side Bar if you prefer it on the right.

- **Detected stack**: language, framework, build tool, test counts, tags, and warnings.
- **Options**: YAML version (auto, v0.2 or v0.1), OS, mode, split, concurrency, retries, timeout, tunnel. The YAML regenerates when you change them.
- **Chat**: describe what the customer needs ("Windows 11, 10 VMs, split by scenario, tunnel, Chrome and Firefox"). The AI turns it into generator options (or a direct edit when options can't express it), using the bundled knowledge base and your Confluence space.
- **YAML editor**: edit by hand with live validation. Save to the repo, open it in an editor, copy it, dry-run test discovery, or run it with the HyperExecute CLI.
- **MCP server**: the same tools are registered for VS Code agent mode.

Open it from the ⚡ icon in the Activity Bar, the `HyperExecute` status bar item, or **HyperExecute: Open YAML Studio** in the Command Palette. It has three tabs: **Chat**, **YAML** and **Setup**.

AI backends (auto order): Claude Code CLI, then a VS Code language model, then an Anthropic API key, then offline rules.
