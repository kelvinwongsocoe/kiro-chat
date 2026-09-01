// Run with: npm test  (compiles first, then runs against out/usage.js)
//
// The payloads below are the real answers from kiro-cli 2.20.2 over ACP, with
// the account figures replaced. If Kiro changes shape, these are what tell us.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  creditRateOf,
  describeContextWindow,
  formatUsageReport,
  parseAccountUsage,
  readMeter,
  readModelDetails,
  readUsageCommand,
} = require("../out/usage");

const USAGE_DATA = {
  planName: "KIRO PRO+",
  billingCycleReset: "2026-10-01",
  overagesEnabled: false,
  isEnterprise: true,
  usageBreakdowns: [
    {
      resourceType: "CREDIT",
      displayName: "Credits",
      used: 12.5,
      limit: 2000,
      percentage: 1,
      currentOverages: 0,
      overageRate: 0.04,
      overageCharges: 0,
      currency: "USD",
      hasLimit: true,
    },
  ],
  bonusCredits: [],
  addOnCredits: [],
  overageCapable: true,
};

const MODEL_DATA = {
  models: [
    {
      id: "auto",
      displayName: "auto",
      contextWindow: 1000000,
      description: "Models chosen by task for optimal usage and consistent quality",
      rateMultiplier: 1,
    },
    {
      id: "claude-opus-5",
      displayName: "claude-opus-5",
      contextWindow: 1000000,
      description: "Claude Opus 5 model with 1M context window",
      rateMultiplier: 2.2,
    },
    {
      id: "gpt-5.6-luna",
      displayName: "gpt-5.6-luna",
      contextWindow: 272000,
      description: "Experimental preview of OpenAI GPT 5.6 Luna with 272k context window",
      rateMultiplier: 0.1,
    },
  ],
};

test("the usage command's plan figures are read", () => {
  assert.deepEqual(readUsageCommand(USAGE_DATA), {
    planName: "KIRO PRO+",
    accountResetsOn: "2026-10-01",
    accountCreditsUsed: 12.5,
    accountCreditsLimit: 2000,
  });
});

test("an unlimited resource reports no limit rather than a wrong one", () => {
  const data = {
    usageBreakdowns: [{ displayName: "Credits", used: 4, limit: 0, hasLimit: false }],
  };
  const out = readUsageCommand(data);
  assert.equal(out.accountCreditsUsed, 4);
  assert.equal(out.accountCreditsLimit, undefined);
});

test("the usage command is summarised for the transcript", () => {
  assert.equal(
    formatUsageReport(USAGE_DATA),
    [
      "Plan: KIRO PRO+",
      "Credits: 12.5 of 2000 used (1%)",
      "Renews: 2026-10-01",
      "Overages are switched off, so work stops at the limit.",
    ].join("\n")
  );
});

test("an unrecognised usage payload falls back to what Kiro printed", () => {
  assert.equal(formatUsageReport(undefined, "Not signed in."), "Not signed in.");
  assert.equal(formatUsageReport({}, ""), "");
});

test("model credit rates and context windows are read from the model command", () => {
  const details = readModelDetails(MODEL_DATA);
  assert.equal(details.get("claude-opus-5").creditRate, "2.2x");
  assert.equal(details.get("gpt-5.6-luna").creditRate, "0.1x");
  assert.equal(details.get("auto").creditRate, "1x");
  assert.equal(details.get("gpt-5.6-luna").contextWindow, 272000);
  assert.equal(readModelDetails(undefined).size, 0);
});

test("context windows are described in round numbers", () => {
  assert.equal(describeContextWindow(1000000), "1M context");
  assert.equal(describeContextWindow(272000), "272k context");
  assert.equal(describeContextWindow(undefined), undefined);
  assert.equal(describeContextWindow(0), undefined);
});

test("credit rate is read from every spelling Kiro has used", () => {
  assert.equal(creditRateOf({ rateMultiplier: 2.2 }), "2.2x");
  assert.equal(creditRateOf({ creditRate: "1.5x" }), "1.5x");
  assert.equal(creditRateOf({ credit_rate: 2 }), "2x");
  assert.equal(creditRateOf({ pricing: { multiplier: 3 } }), "3x");
  assert.equal(
    creditRateOf({ name: "Sonnet", description: "Fast. 1.00x credits." }),
    "1.00x"
  );
});

test("credit rate is never invented from an unrelated multiplier", () => {
  assert.equal(creditRateOf({ name: "Turbo", description: "200x faster" }), undefined);
  // This is the shape session/new actually sends: no rate anywhere in it.
  assert.equal(
    creditRateOf({
      modelId: "claude-opus-5",
      name: "claude-opus-5",
      description: "Claude Opus 5 model with 1M context window",
    }),
    undefined
  );
});

test("the meter is read whether it is a number or an object", () => {
  assert.deepEqual(readMeter({ meteringUsage: 4.25 }), { sessionCredits: 4.25 });
  assert.deepEqual(readMeter({ meteringUsage: { creditsUsed: 7 } }), {
    sessionCredits: 7,
  });
  assert.deepEqual(readMeter({ contextUsagePercentage: 42 }), { contextPercent: 42 });
  assert.deepEqual(readMeter({}), {});
});

// The prose fallback, for builds whose usage command has no structured data.

test("plan credits read as a used/total pair", () => {
  const out = parseAccountUsage("Credits: 123.5 / 500\nResets on 1 October 2026");
  assert.equal(out.accountCreditsUsed, 123.5);
  assert.equal(out.accountCreditsLimit, 500);
  assert.equal(out.accountResetsOn, "1 October 2026");
});

test("windows line endings and thousands separators are handled", () => {
  const out = parseAccountUsage("You have used 1,240 credits\r\nRenews in 3 days\r\n");
  assert.equal(out.accountCreditsUsed, 1240);
  assert.equal(out.accountResetsOn, "3 days");
});

test("numbers away from the word credit are never treated as a balance", () => {
  assert.deepEqual(parseAccountUsage("Session id 4821 / 9000\nModel: sonnet"), {});
  assert.deepEqual(parseAccountUsage("Not signed in."), {});
});
