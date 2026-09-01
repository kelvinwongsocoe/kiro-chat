// The upgrade notice offers "See what changed" and opens CHANGELOG.md, so a
// version that ships without an entry points the user at a file that does not
// mention the thing they just installed. Bumping the version and forgetting
// the changelog is easy to do and invisible until someone upgrades.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

test("the version being shipped has a changelog entry", () => {
  const heading = new RegExp(`^## ${pkg.version.replace(/\./g, "\.")}\s*$`, "m");
  assert.match(
    changelog,
    heading,
    `CHANGELOG.md has no "## ${pkg.version}" section for the version in package.json`
  );
});

test("the newest entry is the version being shipped", () => {
  const first = changelog.match(/^## (.+)$/m);
  assert.ok(first, "the changelog should have at least one version heading");
  assert.equal(
    first[1].trim(),
    pkg.version,
    "the top entry should be the current version, so the newest changes are read first"
  );
});

/** An entry with a heading and nothing under it is worse than none. */
test("the entry actually says something", () => {
  const body = changelog.split(new RegExp(`^## ${pkg.version.replace(/\./g, "\.")}\s*$`, "m"))[1] ?? "";
  const untilNext = body.split(/^## /m)[0] ?? "";
  assert.ok(
    untilNext.trim().length > 40,
    `the "## ${pkg.version}" section is empty or nearly so`
  );
});
