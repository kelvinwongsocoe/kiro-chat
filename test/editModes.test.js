// How closely Kiro is supervised, as one choice rather than four booleans.
//
// The mode is derived from the settings and never stored, so the only way it
// can be wrong is by disagreeing with them — which is exactly what these
// check.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EDIT_MODES,
  EDIT_MODE_ORDER,
  editModeOf,
  gatesForMode,
} = require("../out/editModes");

test("each named mode reads back as itself", () => {
  for (const name of EDIT_MODE_ORDER) {
    assert.equal(editModeOf(EDIT_MODES[name]), name, `${name} should round-trip`);
  }
});

test("the modes are offered most supervised first", () => {
  assert.deepEqual(EDIT_MODE_ORDER, ["manual", "review", "autopilot"]);
});

/*
 * Manual is the one the whole thing was added for: ask before the write, and
 * still show the diff afterwards. The two are not the same question — Kiro
 * writes the file itself, so the diff can only put it back, while the prompt
 * is the only gate that stops the write reaching disk.
 */
test("manual asks first and reviews afterwards", () => {
  assert.equal(EDIT_MODES.manual.askBeforeEdits, true);
  assert.equal(EDIT_MODES.manual.reviewFileWrites, true);
  assert.equal(EDIT_MODES.manual.autoApproveTools, false);
});

test("review is one gate, and it is the diff", () => {
  assert.equal(EDIT_MODES.review.askBeforeEdits, false);
  assert.equal(EDIT_MODES.review.reviewFileWrites, true);
  assert.equal(EDIT_MODES.review.autoApproveTools, false);
});

test("autopilot asks nothing and shows nothing", () => {
  assert.equal(EDIT_MODES.autopilot.askBeforeEdits, false);
  assert.equal(EDIT_MODES.autopilot.reviewFileWrites, false);
  assert.equal(EDIT_MODES.autopilot.autoApproveTools, true);
});

/** Every mode lets the edits stand. Reverting them is not a degree of care. */
test("no mode quietly turns writing off", () => {
  for (const name of EDIT_MODE_ORDER) {
    assert.equal(EDIT_MODES[name].allowFileWrites, true, `${name} must let edits stand`);
  }
});

/*
 * A combination that is not one of the three is reported as what it is.
 * Rounding it to the nearest mode would show a selected row that does not
 * describe the settings, and the next click would then change ones the user
 * never touched.
 */
test("an unrecognised combination is custom, not the nearest mode", () => {
  assert.equal(
    editModeOf({
      askBeforeEdits: true,
      reviewFileWrites: false,
      allowFileWrites: true,
      autoApproveTools: false,
    }),
    "custom",
    "ask-but-never-review is its own thing"
  );
  // The dry run: edits are made and then put back. Not a degree of supervision.
  assert.equal(
    editModeOf({ ...EDIT_MODES.review, allowFileWrites: false }),
    "custom",
    "restoring every file afterwards is not one of the modes"
  );
});

test("a missing or partial setting counts as off, not as a match", () => {
  assert.equal(editModeOf(undefined), "custom");
  assert.equal(editModeOf({}), "custom");
  // Only `review` differs from all-false by two flags, so nothing accidentally
  // matches an empty object.
  assert.equal(editModeOf({ allowFileWrites: true }), "custom");
});

test("a mode can be turned back into the settings to write", () => {
  assert.deepEqual(gatesForMode("manual"), EDIT_MODES.manual);
  assert.deepEqual(gatesForMode("autopilot"), EDIT_MODES.autopilot);
});

/** `custom` is a reading of the settings, never something to apply. */
test("custom cannot be chosen", () => {
  assert.equal(gatesForMode("custom"), undefined);
  assert.equal(gatesForMode("nonsense"), undefined);
  assert.equal(gatesForMode(""), undefined);
});
