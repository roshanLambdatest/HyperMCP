// Everything the web app uses from the shared core (../../src), plus the virtual filesystem.
// Deliberately NOT included: knowledge base / Confluence (internal content), runner and credentials
// storage (need a real machine), MCP server, feedback capture.
export { analyzeRepo, summarizeProfile } from "../../src/analyzer.js";
export { generateYaml, v02FrameworkName } from "../../src/generator.js";
export { validateYaml } from "../../src/validator.js";
export { optimizeYaml, applyOptimizations, describeSuggestions } from "../../src/optimizer.js";
export { scanRepo, scanCredentials, planCredentialFixes } from "../../src/security.js";
export { capabilityOptions, generateConnection, findDriverSetup } from "../../src/capabilities.js";
export { collectEvidence, diagnose, applyDiagnosisFixes, logDigest, describeDiagnosis } from "../../src/doctor.js";
export { cliDownloadUrl } from "./cli-url.js";
export { generatePipeline, CI_SYSTEMS } from "../../src/pipelines.js";
export { vfsReset, vfsAdd, vfsFiles, vfsRead } from "./shims/fs.js";
export { default as YAML } from "yaml";
