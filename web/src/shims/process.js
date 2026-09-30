// A minimal `process` global for the browser build: empty env (so no saved account is ever picked up
// from an environment), Linux platform for command defaults, and no-op event hooks.
export const process = { env: {}, platform: "linux", pid: 1, cwd: () => "/repo", once() {}, on() {}, execPath: "node" };
