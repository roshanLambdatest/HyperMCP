// Display names for detected stack ids, plus an English plural that handles "class" → "classes".
const FW = { testng: "TestNG", junit5: "JUnit 5", junit4: "JUnit 4", spock: "Spock", cucumber: "Cucumber", karate: "Karate", serenity: "Serenity", playwright: "Playwright", cypress: "Cypress", webdriverio: "WebdriverIO", "cucumber-js": "Cucumber.js", nightwatch: "Nightwatch", testcafe: "TestCafe", jest: "Jest", mocha: "Mocha", pytest: "pytest", "pytest-bdd": "pytest-bdd", behave: "Behave", robot: "Robot Framework", nunit: "NUnit", xunit: "xUnit", mstest: "MSTest", specflow: "SpecFlow" };
const TOOL = { maven: "Maven", gradle: "Gradle", dotnet: ".NET CLI", npm: "npm", yarn: "Yarn", pnpm: "pnpm" };
const LANG = { java: "Java", node: "Node.js", python: "Python", csharp: ".NET" };
export const fwName = (id) => FW[id] || id || "";
export const toolName = (id) => TOOL[id] || id || "";
export const langName = (id) => LANG[id] || id || "";
export const stackLine = (p, fw) => [p.language && `${langName(p.language)}${p.runtimeVersion ? " " + p.runtimeVersion : ""}`, toolName(p.buildTool || p.packageManager), fwName(fw)].filter(Boolean).join(" · ");
export function plural(n, word) {
  if (n === 1) return `${n} ${word}`;
  const w = /(s|x|ch|sh)$/.test(word) ? word + "es" : /[^aeiou]y$/.test(word) ? word.slice(0, -1) + "ies" : word + "s";
  return `${n} ${w}`;
}
