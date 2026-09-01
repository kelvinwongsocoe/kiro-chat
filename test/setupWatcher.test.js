// The setup screen drives itself: it watches for kiro-cli appearing, then
// tries to connect without the user pressing anything. Everything that can go
// wrong here is invisible in the UI — a poll that never stops, a state emitted
// after the panel closed, a retry loop that spins forever — so the state
// machine is tested on its own, away from vscode.
const test = require("node:test");
const assert = require("node:assert/strict");

const { SetupWatcher } = require("../out/setupWatcher");

/**
 * Stands in for setTimeout. Nothing fires until the test says so, so a poll
 * that should not have been scheduled shows up as an empty queue rather than
 * as a test that mysteriously takes ten minutes.
 */
function fakeScheduler() {
  let next = 1;
  const timers = new Map();
  return {
    scheduler: {
      set(fn, ms) {
        const handle = next++;
        timers.set(handle, { fn, ms });
        return handle;
      },
      clear(handle) {
        timers.delete(handle);
      },
    },
    get pending() {
      return timers.size;
    },
    /** Longest wait currently queued, for asserting the backoff changed. */
    get delay() {
      return [...timers.values()][0]?.ms;
    },
    /** Fire every queued timer once and let the async work settle. */
    async fire(watcher) {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, timer] of due) timer.fn();
      await watcher.settled();
    },
  };
}

function record() {
  const states = [];
  return { states, onState: (state, detail) => states.push([state, detail]) };
}

test("polling stops the moment kiro-cli connects", async () => {
  const clock = fakeScheduler();
  const log = record();
  let probes = 0;

  const watcher = new SetupWatcher({
    probe: async () => (++probes >= 2 ? "C:\\Kiro\\kiro-cli.exe" : undefined),
    connect: async () => undefined,
    onState: log.onState,
    scheduler: clock.scheduler,
  });

  watcher.start();
  await clock.fire(watcher); // first probe: not there yet
  assert.equal(clock.pending, 1, "a miss should schedule another look");

  await clock.fire(watcher); // second probe: found, then connects

  assert.deepEqual(
    log.states.map((s) => s[0]),
    ["looking", "found", "connecting", "connected"]
  );
  assert.equal(log.states[1][1], "C:\\Kiro\\kiro-cli.exe", "the path is reported");
  assert.equal(clock.pending, 0, "nothing should still be queued after connecting");
  assert.equal(probes, 2, "probing stops once it is found");
});

test("a binary that will not connect asks the user to sign in", async () => {
  const clock = fakeScheduler();
  const log = record();

  const watcher = new SetupWatcher({
    probe: async () => "kiro-cli.exe",
    connect: async () => {
      throw new Error("not signed in");
    },
    onState: log.onState,
    scheduler: clock.scheduler,
  });

  watcher.start();
  await clock.fire(watcher);

  assert.deepEqual(
    log.states.map((s) => s[0]),
    ["looking", "found", "connecting", "needs-signin"]
  );
  assert.equal(log.states[3][1], "not signed in", "the reason is passed through");
  assert.equal(
    clock.pending,
    0,
    "it must wait for the user to sign in rather than retrying on its own"
  );
});

test("signing in retries the handshake and connects", async () => {
  const clock = fakeScheduler();
  const log = record();
  let attempts = 0;

  const watcher = new SetupWatcher({
    probe: async () => "kiro-cli.exe",
    connect: async () => {
      if (++attempts < 3) throw new Error("still not signed in");
    },
    onState: log.onState,
    scheduler: clock.scheduler,
  });

  watcher.start();
  await clock.fire(watcher); // found, connect fails -> needs-signin

  watcher.signIn();
  await clock.fire(watcher); // retry 2: still failing
  assert.equal(clock.pending, 1, "a failed retry should queue another");

  await clock.fire(watcher); // retry 3: connects

  assert.equal(log.states.at(-1)[0], "connected");
  assert.equal(clock.pending, 0);
});

test("looking for the binary gives up rather than polling forever", async () => {
  const clock = fakeScheduler();
  const log = record();
  let probes = 0;

  const watcher = new SetupWatcher({
    probe: async () => {
      probes++;
      return undefined;
    },
    connect: async () => undefined,
    onState: log.onState,
    scheduler: clock.scheduler,
    maxLookAttempts: 3,
  });

  watcher.start();
  for (let i = 0; i < 5 && clock.pending > 0; i++) await clock.fire(watcher);

  assert.equal(probes, 3, "it should stop at the cap");
  assert.equal(log.states.at(-1)[0], "gave-up");
  assert.equal(clock.pending, 0, "nothing is left running");
});

test("sign-in retries give up too", async () => {
  const clock = fakeScheduler();
  const log = record();

  const watcher = new SetupWatcher({
    probe: async () => "kiro-cli.exe",
    connect: async () => {
      throw new Error("nope");
    },
    onState: log.onState,
    scheduler: clock.scheduler,
    maxSignInAttempts: 2,
  });

  watcher.start();
  await clock.fire(watcher);

  watcher.signIn();
  for (let i = 0; i < 5 && clock.pending > 0; i++) await clock.fire(watcher);

  assert.equal(log.states.at(-1)[0], "gave-up");
  assert.equal(clock.pending, 0);
});

test("sign-in polls more slowly than the hunt for the binary", async () => {
  const clock = fakeScheduler();
  const log = record();

  const watcher = new SetupWatcher({
    probe: async () => undefined,
    connect: async () => {
      throw new Error("nope");
    },
    onState: log.onState,
    scheduler: clock.scheduler,
    lookIntervalMs: 2000,
    signInIntervalMs: 5000,
  });

  watcher.start();
  assert.equal(clock.delay, 2000, "looking for the binary uses the short interval");

  watcher.signIn();
  assert.equal(clock.delay, 5000, "signing in backs off");
});

test("stopping silences the watcher for good", async () => {
  const clock = fakeScheduler();
  const log = record();

  const watcher = new SetupWatcher({
    probe: async () => "kiro-cli.exe",
    connect: async () => undefined,
    onState: log.onState,
    scheduler: clock.scheduler,
  });

  watcher.start();
  watcher.stop();

  assert.equal(clock.pending, 0, "the queued poll is cancelled");
  const afterStop = log.states.length;

  // Starting again after a stop is how reopening the panel behaves.
  watcher.start();
  await clock.fire(watcher);
  assert.ok(log.states.length > afterStop, "a restarted watcher works again");
});

/**
 * The panel can be closed mid-probe. The promise is already in flight and
 * cannot be cancelled, so the watcher has to drop the result on the floor
 * instead of reporting a state into a webview that is gone.
 */
test("a probe that lands after stop is ignored", async () => {
  const clock = fakeScheduler();
  const log = record();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });

  const watcher = new SetupWatcher({
    probe: async () => {
      await held;
      return "kiro-cli.exe";
    },
    connect: async () => undefined,
    onState: log.onState,
    scheduler: clock.scheduler,
  });

  watcher.start();
  const inFlight = clock.fire(watcher);
  watcher.stop();
  release();
  await inFlight;

  assert.deepEqual(
    log.states.map((s) => s[0]),
    ["looking"],
    "nothing should be reported once the watcher is stopped"
  );
});

test("start is idempotent", async () => {
  const clock = fakeScheduler();
  const log = record();

  const watcher = new SetupWatcher({
    probe: async () => undefined,
    connect: async () => undefined,
    onState: log.onState,
    scheduler: clock.scheduler,
  });

  watcher.start();
  watcher.start();
  watcher.start();

  assert.equal(clock.pending, 1, "three starts must not stack three polls");
});

/**
 * Restarting the agent tears the client down and builds it again. A slow
 * spawn or a dropped pipe makes that first attempt fail for reasons that fix
 * themselves, so a reconnect retries quietly behind the loading state rather
 * than throwing a setup screen at someone who was chatting a moment ago.
 */
test("a reconnect retries quietly and reports nothing when it works", async () => {
  const clock = fakeScheduler();
  const log = record();
  let attempts = 0;

  const watcher = new SetupWatcher({
    probe: async () => "kiro-cli.exe",
    connect: async () => {
      if (++attempts < 3) throw new Error("pipe closed");
    },
    onState: log.onState,
    scheduler: clock.scheduler,
  });

  watcher.reconnect();
  await watcher.settled(); // attempt 1 runs straight away
  await clock.fire(watcher); // try 2 — still failing
  await clock.fire(watcher); // try 3 — connects

  assert.equal(attempts, 3);
  assert.equal(log.states.at(-1)[0], "connected");
  assert.equal(clock.pending, 0, "a connected reconnect leaves nothing running");
  assert.ok(
    log.states.every(([state]) => state !== "needs-signin"),
    "a reconnect that works must never mention signing in"
  );
});

/**
 * When the retries are used up the user has to be told — but with what
 * actually went wrong, not an assumption about their login.
 */
test("a reconnect that never works reports the real error", async () => {
  const clock = fakeScheduler();
  const log = record();

  const watcher = new SetupWatcher({
    probe: async () => "kiro-cli.exe",
    connect: async () => {
      throw new Error("Kiro did not return a session id.");
    },
    onState: log.onState,
    scheduler: clock.scheduler,
    maxReconnectAttempts: 3,
  });

  watcher.reconnect();
  await watcher.settled(); // attempt 1 runs straight away
  for (let i = 0; i < 5 && clock.pending > 0; i++) await clock.fire(watcher);

  const last = log.states.at(-1);
  assert.equal(last[0], "failed");
  assert.equal(last[1], "Kiro did not return a session id.", "the real error is carried");
  assert.equal(clock.pending, 0);
});

test("a reconnect gives up after exactly the attempts it was given", async () => {
  const clock = fakeScheduler();
  const log = record();
  let attempts = 0;

  const watcher = new SetupWatcher({
    probe: async () => "kiro-cli.exe",
    connect: async () => {
      attempts++;
      throw new Error("nope");
    },
    onState: log.onState,
    scheduler: clock.scheduler,
    maxReconnectAttempts: 3,
  });

  watcher.reconnect();
  await watcher.settled(); // attempt 1 runs straight away
  for (let i = 0; i < 8 && clock.pending > 0; i++) await clock.fire(watcher);

  assert.equal(attempts, 3, "three tries, not two and not four");
});

test("stopping a reconnect silences it like any other phase", async () => {
  const clock = fakeScheduler();
  const log = record();

  const watcher = new SetupWatcher({
    probe: async () => "kiro-cli.exe",
    connect: async () => {
      throw new Error("nope");
    },
    onState: log.onState,
    scheduler: clock.scheduler,
  });

  watcher.reconnect();
  await watcher.settled(); // attempt 1 runs straight away
  await clock.fire(watcher);
  watcher.stop();

  assert.equal(clock.pending, 0, "the queued retry is cancelled");
});
