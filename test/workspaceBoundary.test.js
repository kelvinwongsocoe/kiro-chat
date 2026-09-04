// The security boundary: what counts as "inside the open folders".
//
// The old check compared paths as written. That defeats `../`, but it says
// nothing about a symlink or a Windows junction *inside* the workspace pointing
// out of it — that resolves to an in-workspace string and was accepted, so
// "reading and writing is limited to your open workspace folders" was not quite
// true. These tests use real links on disk, because the whole failure was that
// the string looked fine.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { realPathOf, isInsideRoot, isInsideAnyRoot } = require("../out/workspacePaths");

/**
 * Creating links is not guaranteed to be permitted: on Windows a symlink needs
 * either Developer Mode or elevation. A directory junction usually works
 * without either, so that is tried first. When neither is allowed the test says
 * it was skipped rather than passing without having checked anything.
 */
function tryLink(target, linkPath, isDirectory) {
  const kinds = isDirectory ? ["junction", "dir"] : ["file"];
  for (const kind of kinds) {
    try {
      fs.symlinkSync(target, linkPath, kind);
      return true;
    } catch {
      // Try the next kind.
    }
  }
  return false;
}

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-boundary-"));
  // realpath the base itself: on Windows the temp dir is often under a
  // shortened path, and comparing an unresolved root to resolved children
  // would fail for reasons that have nothing to do with what is being tested.
  const root = fs.realpathSync(base);
  return {
    root,
    inside: path.join(root, "workspace"),
    outside: path.join(root, "elsewhere"),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test("a file genuinely inside the workspace is allowed", () => {
  const box = sandbox();
  try {
    fs.mkdirSync(box.inside, { recursive: true });
    const file = path.join(box.inside, "app.ts");
    fs.writeFileSync(file, "export {};\n");

    assert.equal(isInsideAnyRoot([box.inside], file), true);
  } finally {
    box.cleanup();
  }
});

test("a path climbing out with .. is still refused", () => {
  const box = sandbox();
  try {
    fs.mkdirSync(box.inside, { recursive: true });
    fs.mkdirSync(box.outside, { recursive: true });
    const escape = path.join(box.inside, "..", "elsewhere", "secrets.env");

    assert.equal(isInsideAnyRoot([box.inside], escape), false);
  } finally {
    box.cleanup();
  }
});

/** The one the old check missed. */
test("a junction inside the workspace pointing out of it is refused", (t) => {
  const box = sandbox();
  try {
    fs.mkdirSync(box.inside, { recursive: true });
    fs.mkdirSync(box.outside, { recursive: true });
    fs.writeFileSync(path.join(box.outside, "secrets.env"), "TOKEN=hunter2\n");

    const link = path.join(box.inside, "linked");
    if (!tryLink(box.outside, link, true)) {
      t.skip("this system does not allow creating links without elevation");
      return;
    }

    const through = path.join(link, "secrets.env");
    // The string alone looks entirely reasonable — that was the whole problem.
    assert.equal(isInsideRoot(box.inside, through), true, "the written path looks contained");
    assert.equal(
      isInsideAnyRoot([box.inside], through),
      false,
      "but it really lands outside the workspace and must be refused"
    );
  } finally {
    box.cleanup();
  }
});

/** A link that stays inside the workspace is ordinary and must keep working. */
test("a junction pointing somewhere else inside the workspace is allowed", (t) => {
  const box = sandbox();
  try {
    const packages = path.join(box.inside, "packages", "core");
    fs.mkdirSync(packages, { recursive: true });
    fs.writeFileSync(path.join(packages, "index.ts"), "export {};\n");

    const link = path.join(box.inside, "core-link");
    if (!tryLink(packages, link, true)) {
      t.skip("this system does not allow creating links without elevation");
      return;
    }

    assert.equal(isInsideAnyRoot([box.inside], path.join(link, "index.ts")), true);
  } finally {
    box.cleanup();
  }
});

/**
 * A workspace folder reached through a link has to keep containing its own
 * files. Resolving only one side would make every file under it look external.
 */
test("a workspace root that is itself a link still contains its files", (t) => {
  const box = sandbox();
  try {
    const real = path.join(box.root, "real-project");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "app.ts"), "export {};\n");

    const rootLink = path.join(box.root, "project-link");
    if (!tryLink(real, rootLink, true)) {
      t.skip("this system does not allow creating links without elevation");
      return;
    }

    assert.equal(isInsideAnyRoot([rootLink], path.join(rootLink, "app.ts")), true);
    // And the real path is the same folder, so it is inside too.
    assert.equal(isInsideAnyRoot([rootLink], path.join(real, "app.ts")), true);
  } finally {
    box.cleanup();
  }
});

// ---------------------------------------------------------------------------
// realPathOf
// ---------------------------------------------------------------------------

/**
 * A file being created has no real path of its own, but the directory it lands
 * in does — and that is the part a link could redirect. Refusing every new file
 * would break writing one at all.
 */
test("a file that does not exist yet resolves through its parent", () => {
  const box = sandbox();
  try {
    fs.mkdirSync(box.inside, { recursive: true });
    const unborn = path.join(box.inside, "deeply", "nested", "new-file.ts");

    assert.equal(realPathOf(unborn), unborn, "a path under a real directory is itself");
    assert.equal(isInsideAnyRoot([box.inside], unborn), true, "creating a file must still work");
  } finally {
    box.cleanup();
  }
});

test("a new file under a link that escapes is still refused", (t) => {
  const box = sandbox();
  try {
    fs.mkdirSync(box.inside, { recursive: true });
    fs.mkdirSync(box.outside, { recursive: true });

    const link = path.join(box.inside, "linked");
    if (!tryLink(box.outside, link, true)) {
      t.skip("this system does not allow creating links without elevation");
      return;
    }

    // Creating, not reading — the write path has to be as careful as the read.
    const unborn = path.join(link, "planted.ts");
    assert.equal(isInsideAnyRoot([box.inside], unborn), false);
  } finally {
    box.cleanup();
  }
});

/** Nothing on the path exists at all: there is no link to see through. */
test("a path with no existing ancestor resolves to itself", () => {
  const missing = path.join(os.tmpdir(), "kiro-not-here-at-all", "a", "b", "c.ts");
  assert.equal(realPathOf(missing), path.resolve(missing));
});

test("resolution failures do not throw the boundary open", () => {
  const box = sandbox();
  try {
    fs.mkdirSync(box.inside, { recursive: true });
    const explode = () => {
      throw new Error("realpath is unavailable");
    };
    // With nothing resolvable, the path falls back to its written form — which
    // still has to be judged, not waved through.
    assert.equal(isInsideAnyRoot([box.inside], path.join(box.inside, "a.ts"), explode), true);
    assert.equal(isInsideAnyRoot([box.inside], path.join(box.outside, "a.ts"), explode), false);
  } finally {
    box.cleanup();
  }
});
