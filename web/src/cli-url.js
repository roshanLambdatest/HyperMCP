// HyperExecute CLI download links, per the visitor's OS (same URLs as src/runner.js).
export function cliDownloadUrl(os) {
  const p = os === "win" ? "windows" : os === "mac" ? "darwin" : "linux";
  return `https://downloads.lambdatest.com/hyperexecute/${p}/hyperexecute${p === "windows" ? ".exe" : ""}`;
}
