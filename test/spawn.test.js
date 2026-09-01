// How Kiro gets launched. These only differ on Windows, where the CLI is often
// a .cmd shim and Node refuses to spawn one without a shell.
const test = require("node:test");
const assert = require("node:assert/strict");

const { needsShell, quote } = require("../out/acpClient");

const onWindows = process.platform === "win32";

test("batch shims go through the shell, real executables do not", () => {
  assert.equal(needsShell("C:\\Users\\me\\kiro-cli.cmd"), onWindows);
  assert.equal(needsShell("C:\\Users\\me\\kiro-cli.BAT"), onWindows);
  assert.equal(needsShell("C:\\Users\\me\\kiro-cli.exe"), false);
  assert.equal(needsShell("/usr/local/bin/kiro-cli"), false);
  assert.equal(needsShell("wsl"), false);
});

test("quoting protects paths the shell would otherwise split", () => {
  assert.equal(quote("C:\\Program Files\\Kiro\\kiro-cli.cmd"), '"C:\\Program Files\\Kiro\\kiro-cli.cmd"');
  assert.equal(quote("acp"), "acp");
  assert.equal(quote('"already quoted"'), '"already quoted"');
  assert.equal(quote("a&b"), '"a&b"');
  assert.equal(quote(""), "");
});
