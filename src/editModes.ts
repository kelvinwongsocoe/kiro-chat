/**
 * How closely Kiro is supervised when it edits a file.
 *
 * Four booleans — `askBeforeEdits`, `reviewFileWrites`, `allowFileWrites` and
 * `autoApproveTools` — together say one thing: how much of an edit the user
 * wants to see before it counts. Presented as four switches that is a puzzle,
 * and the names actively mislead: turning `reviewFileWrites` off reads as
 * turning safety off, when it only swaps which gate you get. Named modes say
 * the thing the settings are really about.
 *
 * The mode is **derived**, never stored. A stored one would be a second
 * source of truth that drifts the moment someone edits the JSON, and this
 * codebase has paid for that mistake several times. Any combination that is
 * not one of the three named ones is honestly reported as `custom` rather
 * than rounded to the nearest mode.
 *
 * Free of any `vscode` import so it can be exercised on its own — see
 * `test/editModes.test.js`.
 */

/** The gates a mode is made of. */
export interface EditGates {
  /** Ask permission before an edit, as well as reviewing it afterwards. */
  askBeforeEdits: boolean;
  /** Open the inline diff for each edit. */
  reviewFileWrites: boolean;
  /** Let the edits stand, rather than restoring every file after the turn. */
  allowFileWrites: boolean;
  /** Answer every permission request without asking. */
  autoApproveTools: boolean;
}

export type NamedEditMode = "manual" | "review" | "autopilot";
export type EditMode = NamedEditMode | "custom";

/**
 * The three points on the spectrum, most supervised first.
 *
 * `allowFileWrites: false` is deliberately not one of them. It restores every
 * file at the end of the turn, which is a dry run rather than a degree of
 * supervision — and because Kiro CLI writes the files itself, the change does
 * reach disk in between. Turning it off therefore reads as `custom`, which is
 * what it is.
 */
export const EDIT_MODES: Record<NamedEditMode, EditGates> = {
  manual: {
    askBeforeEdits: true,
    reviewFileWrites: true,
    allowFileWrites: true,
    autoApproveTools: false,
  },
  review: {
    askBeforeEdits: false,
    reviewFileWrites: true,
    allowFileWrites: true,
    autoApproveTools: false,
  },
  autopilot: {
    askBeforeEdits: false,
    reviewFileWrites: false,
    allowFileWrites: true,
    autoApproveTools: true,
  },
};

/** The order they are offered in: most supervised to least. */
export const EDIT_MODE_ORDER: NamedEditMode[] = ["manual", "review", "autopilot"];

function gatesMatch(a: EditGates, b: EditGates): boolean {
  return (
    a.askBeforeEdits === b.askBeforeEdits &&
    a.reviewFileWrites === b.reviewFileWrites &&
    a.allowFileWrites === b.allowFileWrites &&
    a.autoApproveTools === b.autoApproveTools
  );
}

/**
 * Which mode these settings are in, or `custom` if they are in none of them.
 *
 * Reported honestly on purpose. Rounding an unrecognised combination to the
 * nearest mode would show a selected row that does not describe what is
 * actually configured, and the next click would then silently change settings
 * the user never touched.
 */
export function editModeOf(gates: Partial<EditGates> | undefined): EditMode {
  const value: EditGates = {
    askBeforeEdits: gates?.askBeforeEdits === true,
    reviewFileWrites: gates?.reviewFileWrites === true,
    allowFileWrites: gates?.allowFileWrites === true,
    autoApproveTools: gates?.autoApproveTools === true,
  };
  for (const name of EDIT_MODE_ORDER) {
    if (gatesMatch(value, EDIT_MODES[name])) return name;
  }
  return "custom";
}

/** The settings to write for a mode. `custom` is a reading, never a choice. */
export function gatesForMode(mode: string): EditGates | undefined {
  return EDIT_MODES[mode as NamedEditMode];
}
