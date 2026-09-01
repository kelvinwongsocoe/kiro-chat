// How Kiro gets launched. The CLI is often a .cmd shim, and Node refuses to
// spawn one without a shell.
const test = require("node:test");
const assert = require("node:assert/strict");

const { needsShell, quote } = require("../out/acpClient");

test("batch shims go through the shell, real executables do not", () => {
  assert.equal(needsShell("C:\\Users\\me\\kiro-cli.cmd"), true);
  assert.equal(needsShell("C:\\Users\\me\\kiro-cli.BAT"), true);
  assert.equal(needsShell("C:\\Users\\me\\kiro-cli.exe"), false);
  assert.equal(needsShell("wsl"), false);
});

test("quoting protects paths the shell would otherwise split", () => {
  assert.equal(quote("C:\\Program Files\\Kiro\\kiro-cli.cmd"), '"C:\\Program Files\\Kiro\\kiro-cli.cmd"');
  assert.equal(quote("acp"), "acp");
  assert.equal(quote('"already quoted"'), '"already quoted"');
  assert.equal(quote("a&b"), '"a&b"');
  assert.equal(quote(""), "");
});
