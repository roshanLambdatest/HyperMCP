// node:os for the browser build: a fixed virtual home, so nothing is read from or written to a real one.
const os = { homedir: () => "/home/studio", tmpdir: () => "/tmp", platform: () => "linux", EOL: "\n" };
export default os;
export const { homedir, tmpdir, platform, EOL } = os;
