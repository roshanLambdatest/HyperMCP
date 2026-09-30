// Prints the weekly rule-review summary: failures the doctor didn't recognize (grouped) and how each rule's fixes fared.
//   npm run feedback            last 30 days
//   npm run feedback -- 7       last 7 days
import { reviewFeedback } from "../src/feedback.js";

const days = Number(process.argv[2]) || 30;
const r = reviewFeedback({ sinceDays: days });
console.log(`Feedback in ${r.dir} (last ${days} days): ${r.unmatchedTotal} unrecognized failure(s)\n`);
for (const g of r.unmatched) {
  console.log(`${String(g.count).padStart(3)}×  [${g.signature}] ${g.headline}`);
  console.log(`       ${g.frameworks.join(", ") || "-"} · ${g.statuses.join(", ")} · last ${g.last.slice(0, 10)} · e.g. ${g.files[0]}`);
}
if (r.suspectRules.length) {
  console.log("\nRules whose fixes were overridden or didn't help:");
  for (const s of r.suspectRules) console.log(`  ${s.id}: applied ${s.applied}, overridden ${s.overridden}, next attempt same failure ${s.nextSameFailure}, passed ${s.nextPassed}`);
}
console.log(`\n${r.next}`);
