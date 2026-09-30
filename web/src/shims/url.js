// node:url for the browser build (only fileURLToPath / pathToFileURL are used by the core).
export const fileURLToPath = (u) => String(u).replace(/^file:\/\//, "") || "/app/core.js";
export const pathToFileURL = (p) => new URL("file://" + p);
export default { fileURLToPath, pathToFileURL };
