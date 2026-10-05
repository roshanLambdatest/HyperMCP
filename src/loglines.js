// Reading HyperExecute logs the way a person does: which lines are noise, and which line names the failure.
// No Node APIs here: the doctor uses this in the browser version too.

export const ERR_LINE = /\b(error|exception|failed|failure|fatal|denied|not found|timed? ?out|refused|cannot|could not|unable|ERR::|panic)\b/i;

// Lines that look like errors but never explain a failure: Maven/Gradle transfer progress (maven-error-diagnostics.jar),
// HyperExecute's cache-restore miss (first run or a changed lockfile), fields of the job-summary JSON
// ("status": "failed"), Maven's closing boilerplate, separators, and passing tests whose names contain "error".
const NOISE = [
  /^(Progress \(\d+\)|Download(ing|ed) from \S+:|Upload(ing|ed) to \S+:)/,
  /drone-cache|restore cache|BlobNotFound|The specified blob does not exist|archive not readable|^RESPONSE 404\b|^ERROR CODE:|<\/?(Message|Error|Code)>|^RequestId:|^Time:\d{4}/,
  /npm (error|ERR!) A complete log of this run/,
  /^"[\w.-]+"\s*:/,
  /^\[ERROR\]\s*(->\s*)?\[Help \d+\]|^\[ERROR\]\s*(Re-run Maven|To see the full stack trace|For more information about the errors|Failed to execute goal .*-> \[Help \d+\]$)|^\[ERROR\]\s*$/,
  /^(\[INFO\]\s*)?[✓✔√]/,
  /\bFailures: 0, Errors: 0\b/,
  /^(\[(ERROR|INFO|WARNING)\]\s*)?[-=*_]{5,}/,
];
// The platform's own summary of a failed job: true, but says nothing about why, so it's the last resort.
const GENERIC = /Exiting with error: Failed tasks found|^\s*FAILED\s*$|Job failed\.?$/i;

// One log line as a reader sees it: no colour codes, only the last \r-overwritten segment, no leading timestamp.
// The CLI's spinner line ("⠼ 14/14 stages completed [32s]") can prefix an error printed on the same line.
// The job summary's "remark" field is the platform's reason, so it reads like its "failed with remark:" line.
export function cleanLine(l) {
  const seg = String(l).replace(/\x1b\[[0-9;]*m/g, "").split("\r").map((s) => s.trim()).filter(Boolean).pop() || "";
  return seg
    .replace(/^[\u2800-\u28ff]\s+\d+\/\d+ stages completed\s+\[\d+s\]\s*/, "")
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:?\d\d)?\s+/, "")
    .replace(/^"remark"\s*:\s*"(.+?)",?$/, "failed with remark: $1")
    .replace(/\s{2,}/g, " ");
}

export const isNoise = (l) => NOISE.some((re) => re.test(l));

export function headline(text) {
  const lines = String(text || "").split("\n").map(cleanLine).filter(Boolean);
  const errs = lines.filter((l) => ERR_LINE.test(l) && !/^\s*at\s/.test(l) && l.length < 400 && !isNoise(l));
  const specific = errs.filter((l) => !GENERIC.test(l));
  // Most specific first: exception/error class names, then HyperExecute error codes, then the platform's
  // "failed with remark" reason, then the last error line; generic summaries only when nothing else is there.
  return (
    specific.find((l) => /[A-Z]\w+(Exception|Error)\b/.test(l)) ||
    specific.find((l) => /ERR::|\bERR_[A-Z]+|\bE\d{3,}\b/.test(l)) ||
    specific.find((l) => /failed with remark:/i.test(l))?.replace(/^.*failed with remark:\s*/i, "") ||
    specific[specific.length - 1] ||
    errs[errs.length - 1] ||
    lines[lines.length - 1] ||
    ""
  ).slice(0, 300);
}
