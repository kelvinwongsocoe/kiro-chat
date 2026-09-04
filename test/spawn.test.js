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

/*
 * Stopping the agent has to reach the agent.
 *
 * When the CLI is a .cmd shim it runs through the shell, so the child this
 * extension holds is cmd.exe and kiro-cli is its grandchild. proc.kill() takes
 * the shell and leaves the agent running — restarting a few times that way
 * builds up live kiro-cli processes still holding their sessions. Windows has
 * no process group to signal, so the tree goes through taskkill instead.
 */
const { killArgs } = require("../out/acpClient");

test("a shell-wrapped agent is killed as a tree, not as a shell", () => {
  assert.deepEqual(killArgs(1234, true, "win32"), ["/pid", "1234", "/t", "/f"]);
});

test("a directly spawned executable takes the ordinary kill", () => {
  assert.equal(killArgs(1234, false, "win32"), undefined);
});

/** Nothing to kill, or nothing taskkill could act on. */
test("a missing or nonsense pid falls back rather than guessing", () => {
  assert.equal(killArgs(undefined, true, "win32"), undefined);
  assert.equal(killArgs(0, true, "win32"), undefined);
  assert.equal(killArgs(-1, true, "win32"), undefined);
  assert.equal(killArgs(1.5, true, "win32"), undefined);
});

/** taskkill is a Windows program; everywhere else kill() is the right thing. */
test("taskkill is not reached for on other platforms", () => {
  assert.equal(killArgs(1234, true, "linux"), undefined);
  assert.equal(killArgs(1234, true, "darwin"), undefined);
});

/*
 * Unterminated stdout must not grow without bound.
 *
 * A line is only dispatched once its newline arrives, so anything without one
 * accumulates forever. The cap has to be applied *after* the line loop, or a
 * single large write full of complete messages — which Kiro does send — would
 * be thrown away wholesale.
 */
const { AcpClient } = require("../out/acpClient");

/** A client that was never started, driven straight through its read path. */
function reader() {
  const seen = { notifications: [], logs: [] };
  const client = new AcpClient({
    command: "kiro-cli",
    args: [],
    onNotification: (method, params) => seen.notifications.push({ method, params }),
    onRequest: async () => null,
    onLog: (line) => seen.logs.push(line),
    onExit: () => {},
  });
  return { client, seen, feed: (chunk) => client.consume(chunk) };
}

test("a big write of complete messages is delivered, not discarded", () => {
  const { seen, feed } = reader();
  // Comfortably over the 1MB cap, but every line is terminated.
  const line = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { pad: "x".repeat(2000) } });
  feed(Array.from({ length: 600 }, () => line).join("\n") + "\n");

  assert.equal(seen.notifications.length, 600, "complete messages must all be dispatched");
  assert.deepEqual(seen.logs, [], "and nothing should have been reported as discarded");
});

test("an unterminated flood is dropped rather than held forever", () => {
  const { client, seen, feed } = reader();
  feed("x".repeat(1024 * 1024 + 10));

  assert.match(seen.logs.join(" "), /Discarded .* unterminated output/);
  assert.equal(client.stdoutBuffer, "", "the buffer should have been released");
});

/** Under the cap it is still a message being assembled; leave it alone. */
test("a partial message under the cap is kept for its rest", () => {
  const { client, feed } = reader();
  feed('{"jsonrpc":"2.0","method":"session/upda');
  assert.notEqual(client.stdoutBuffer, "", "a half-arrived message must survive the chunk boundary");

  feed('te","params":{}}\n');
  assert.equal(client.stdoutBuffer, "");
});

test("a message split across chunks still arrives", () => {
  const { seen, feed } = reader();
  feed('{"jsonrpc":"2.0","method":"session/upda');
  feed('te","params":{"ok":true}}\n');

  assert.equal(seen.notifications.length, 1);
  assert.equal(seen.notifications[0].method, "session/update");
  assert.equal(seen.notifications[0].params.ok, true);
});
