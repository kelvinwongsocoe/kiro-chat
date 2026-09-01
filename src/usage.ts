/**
 * Reading credits, rates and context out of what Kiro tells us.
 *
 * Kept free of any `vscode` import so it can be exercised on its own — see
 * `test/usage.test.js`. The shapes here were read off kiro-cli 2.20.2 over ACP;
 * everything is defensive, because older and newer builds differ and a wrong
 * guess would show the user a made-up number.
 */

export interface UsageInfo {
  contextPercent?: number;
  sessionCredits?: number;
  /** Plan figures, from Kiro's own `usage` command. */
  planName?: string;
  accountCreditsUsed?: number;
  accountCreditsLimit?: number;
  accountResetsOn?: string;
}

export function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (match) return Number(match[0]);
  }
  return undefined;
}

/**
 * Kiro shows credit rates like "1.00x credits" in its own interface. When that
 * appears in a model's name or description we surface it. We never guess one.
 */
export function findCreditRate(...fields: (string | undefined)[]): string | undefined {
  for (const field of fields) {
    // Only trust a multiplier that sits next to the word "credit". Without
    // that guard a phrase like "200x faster" would be shown as a price.
    if (!field || !/credit/i.test(field)) continue;
    const forward = field.match(/(\d+(?:\.\d+)?)\s*(?:x|×)\s*credits?/i);
    if (forward) return `${forward[1]}x`;
    const reversed = field.match(
      /credits?\s*[:=]?\s*(?:x|×)?\s*(\d+(?:\.\d+)?)\s*(?:x|×)?/i
    );
    if (reversed) return `${reversed[1]}x`;
  }
  return undefined;
}

/**
 * Kiro is inconsistent about where a model's credit rate lives, and the model
 * list that comes back with a new session carries no rate at all — that arrives
 * only from the `model` command, as `rateMultiplier`. Check every spelling.
 */
export function creditRateOf(model: any): string | undefined {
  const fields = [
    model?.rateMultiplier,
    model?.rate_multiplier,
    model?.creditRate,
    model?.credit_rate,
    model?.creditMultiplier,
    model?.credit_multiplier,
    model?.credits,
    model?.costMultiplier,
    model?.cost_multiplier,
    model?.rate,
    model?.meta?.creditRate,
    model?.metadata?.creditRate,
    model?._meta?.creditRate,
    model?.pricing?.creditRate,
    model?.pricing?.multiplier,
  ];
  for (const field of fields) {
    const value = numberFrom(field);
    if (value !== undefined) return `${value}x`;
  }
  return findCreditRate(
    model?.name,
    model?.displayName,
    model?.description,
    model?.summary
  );
}

/**
 * The `model` command answers with the rate and context window that the plain
 * session model list leaves out. Returns modelId -> extra detail.
 */
export function readModelDetails(
  data: any
): Map<string, { creditRate?: string; contextWindow?: number }> {
  const out = new Map<string, { creditRate?: string; contextWindow?: number }>();
  const list = data?.models ?? data?.availableModels ?? data;
  if (!Array.isArray(list)) return out;

  for (const model of list) {
    const id = String(model?.id ?? model?.modelId ?? "");
    if (!id) continue;
    out.set(id, {
      creditRate: creditRateOf(model),
      contextWindow: numberFrom(model?.contextWindow ?? model?.context_window),
    });
  }
  return out;
}

/** "1M context" / "272k context" — the number is only useful rounded. */
export function describeContextWindow(tokens: number | undefined): string | undefined {
  if (!tokens || !Number.isFinite(tokens)) return undefined;
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number(millions.toFixed(1))}M context`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k context`;
  return `${tokens} context`;
}

/**
 * Read the meter Kiro attaches to its notifications. `meteringUsage` has been
 * seen as a bare number and as an object with the figure under one of several
 * names, so try each rather than assuming one shape.
 */
export function readMeter(params: any): Partial<UsageInfo> {
  const out: Partial<UsageInfo> = {};

  const percent = Number(params?.contextUsagePercentage);
  if (Number.isFinite(percent)) out.contextPercent = percent;

  const metering = params?.meteringUsage;
  if (typeof metering === "number" && Number.isFinite(metering)) {
    out.sessionCredits = metering;
  } else if (metering && typeof metering === "object") {
    const candidate = [
      metering.credits,
      metering.total,
      metering.amount,
      metering.creditsUsed,
      metering.used,
    ].find((v) => typeof v === "number" && Number.isFinite(v));
    if (candidate !== undefined) out.sessionCredits = Number(candidate);
  }

  return out;
}

interface Breakdown {
  label: string;
  used?: number;
  limit?: number;
  percentage?: number;
  overageCharges?: number;
  currency?: string;
}

function breakdownsOf(data: any): Breakdown[] {
  const groups = [
    data?.usageBreakdowns,
    data?.bonusCredits,
    data?.addOnCredits,
  ].filter(Array.isArray);

  const out: Breakdown[] = [];
  for (const group of groups) {
    for (const entry of group) {
      const label = String(
        entry?.displayName ?? entry?.resourceType ?? entry?.name ?? "Credits"
      );
      out.push({
        label,
        used: numberFrom(entry?.used),
        limit: entry?.hasLimit === false ? undefined : numberFrom(entry?.limit),
        percentage: numberFrom(entry?.percentage),
        overageCharges: numberFrom(entry?.overageCharges),
        currency: entry?.currency ? String(entry.currency) : undefined,
      });
    }
  }
  return out;
}

/**
 * Pull the plan figures out of the `usage` command's structured answer. The
 * credit line is the one the strip shows; the rest goes in the report card.
 */
export function readUsageCommand(data: any): Partial<UsageInfo> {
  const out: Partial<UsageInfo> = {};
  if (!data || typeof data !== "object") return out;

  if (data.planName) out.planName = String(data.planName);
  if (data.billingCycleReset) out.accountResetsOn = String(data.billingCycleReset);

  const breakdowns = breakdownsOf(data);
  const credits =
    breakdowns.find((b) => /credit/i.test(b.label)) ?? breakdowns[0];
  if (credits?.used !== undefined) out.accountCreditsUsed = credits.used;
  if (credits?.limit !== undefined) out.accountCreditsLimit = credits.limit;

  return out;
}

const money = (amount: number, currency?: string) =>
  currency === "USD" ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency ?? ""}`.trim();

/** Turn the `usage` answer into the card shown in the transcript. */
export function formatUsageReport(data: any, fallback = ""): string {
  const breakdowns = breakdownsOf(data);
  if (breakdowns.length === 0 && !data?.planName) return fallback;

  const lines: string[] = [];
  if (data?.planName) lines.push(`Plan: ${String(data.planName)}`);

  for (const entry of breakdowns) {
    if (entry.used === undefined) continue;
    const total = entry.limit !== undefined ? ` of ${entry.limit}` : "";
    const percent =
      entry.percentage !== undefined && entry.limit !== undefined
        ? ` (${entry.percentage}%)`
        : "";
    lines.push(`${entry.label}: ${entry.used}${total} used${percent}`);
    if (entry.overageCharges) {
      lines.push(`  Overage so far: ${money(entry.overageCharges, entry.currency)}`);
    }
  }

  if (data?.billingCycleReset) lines.push(`Renews: ${String(data.billingCycleReset)}`);
  if (data?.overagesEnabled === false && data?.overageCapable) {
    lines.push("Overages are switched off, so work stops at the limit.");
  }

  return lines.join("\n") || fallback;
}

/**
 * Last resort for builds whose `usage` command answers with prose instead of
 * data. Only lines that talk about credits are considered, so a stray number
 * elsewhere in the report is never mistaken for a balance.
 */
export function parseAccountUsage(report: string): Partial<UsageInfo> {
  const out: Partial<UsageInfo> = {};

  const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`;
  const pairPattern = new RegExp(
    String.raw`(${NUMBER})\s*(?:\/|of|out of)\s*(${NUMBER})`,
    "i"
  );
  const singlePattern = new RegExp(
    String.raw`(?:used|spent|consumed)[^\d]{0,20}(${NUMBER})`,
    "i"
  );
  const resetPattern = /(?:resets?|renews?)[a-z]*\s*(?:on|at|in)?\s*[:\-]?\s*(.+)$/i;
  const toNumber = (text: string) => Number(text.replace(/,/g, ""));

  for (const line of report.split(/\r?\n/)) {
    if (/credit/i.test(line) && out.accountCreditsUsed === undefined) {
      const pair = line.match(pairPattern);
      if (pair) {
        out.accountCreditsUsed = toNumber(pair[1]);
        out.accountCreditsLimit = toNumber(pair[2]);
      } else {
        const single = line.match(singlePattern);
        if (single) out.accountCreditsUsed = toNumber(single[1]);
      }
    }
    if (/reset|renew/i.test(line) && !out.accountResetsOn) {
      const when = line.match(resetPattern);
      const text = when?.[1]?.trim().replace(/[.\s]+$/, "");
      if (text && text.length <= 40) out.accountResetsOn = text;
    }
  }

  return out;
}
