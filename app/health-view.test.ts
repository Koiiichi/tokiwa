import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  estimateSpend,
  healthLines,
  lineText,
  loadHealthConfig,
  spendReading,
  type Span,
} from "./health-view";
import {
  fixtureConfig,
  fixtureModel,
  fixtureNow,
  fixtureSample,
  fixtureSpend,
} from "./health-fixture";

const text = (lines: Span[][]) => lines.map(lineText).join("\n");
const row = (lines: Span[][], start: string) =>
  lines.find((line) => lineText(line).trimStart().startsWith(start))!;
const configFile = (content: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "health-config-")), "h.json");
  writeFileSync(path, content);
  return path;
};

test("a missing configuration file gives the defaults: no budget, no end, no instance price", () => {
  const result = loadHealthConfig("/nonexistent/tokiwa/health.json");
  expect(result.error).toBeUndefined();
  expect(result.config).toEqual(DEFAULT_CONFIG);
  expect(DEFAULT_CONFIG.budget_usd).toBeUndefined();
  expect(DEFAULT_CONFIG.authorization_end).toBeUndefined();
  expect(DEFAULT_CONFIG.prices).toEqual({
    instance_hour: {},
    volume_gb_month: { gp3: 0.08 },
    public_ipv4_hour: 0.005,
  });
});

test("a partial configuration file keeps the other defaults", () => {
  const result = loadHealthConfig(
    configFile(
      JSON.stringify({
        budget_usd: 400,
        prices: { instance_hour: { "m7i.4xlarge": 0.8064 } },
      }),
    ),
  );
  expect(result.error).toBeUndefined();
  expect(result.config.budget_usd).toBe(400);
  expect(result.config.authorization_end).toBeUndefined();
  expect(result.config.prices.instance_hour).toEqual({ "m7i.4xlarge": 0.8064 });
  expect(result.config.prices.public_ipv4_hour).toBe(0.005);
});

test("without a budget or an end, Spend shows amounts to the end of the month and Host no end row", () => {
  const { budget_usd, authorization_end, ...rest } = fixtureConfig;
  const lines = healthLines(fixtureModel({ config: rest }), 96);
  const all = text(lines);
  expect(all).not.toContain("budget");
  expect(all).not.toContain("Authorization:");
  expect(lineText(row(lines, "Spent so far:")).trim()).toMatch(
    /^Spent so far: +\$\d+\.\d\d$/,
  );
  // The fixture time is in December 2026, so the forecast runs to December 31.
  expect(lineText(row(lines, "Forecast:"))).toMatch(/by Dec 31$/);
  const estimate = estimateSpend(fixtureSpend, rest, fixtureNow);
  expect("percent" in estimate && estimate.percent).toBeFalsy();
});

test("without a price for the instance type, Spend names the missing price", () => {
  const lines = healthLines(fixtureModel({ config: DEFAULT_CONFIG }), 96);
  expect(text(lines)).toContain("no price for m7i.2xlarge in health.json");
});

test("an invalid configuration file gives a clear error", () => {
  for (const [content, message] of [
    ["{", "is not valid JSON"],
    ['{"budget_usd": -5}', "budget_usd must be a positive number"],
    ['{"authorization_end": "Dec 22"}', "authorization_end must be"],
    [
      '{"prices": {"volume_gb_month": {"gp3": "x"}}}',
      "prices.volume_gb_month.gp3",
    ],
    ['{"budget": 300}', "unknown key budget"],
  ]) {
    const path = configFile(content);
    const result = loadHealthConfig(path);
    expect(result.error).toContain(path);
    expect(result.error).toContain(message);
  }
});

test("the spend reading rejects an incomplete inventory", () => {
  expect(spendReading(fixtureSpend)).toEqual(fixtureSpend);
  for (const broken of [
    { ...fixtureSpend, instance: null },
    { ...fixtureSpend, volumes: [{ id: "v", type: "gp3", size_gib: -1 }] },
    { ...fixtureSpend, instance: { ...fixtureSpend.instance, type: 3 } },
  ])
    expect(() => spendReading(broken)).toThrow("spend reading is invalid");
});

test("the estimate uses list prices from the month start to the authorization end", () => {
  const estimate = estimateSpend(fixtureSpend, fixtureConfig, fixtureNow);
  if ("error" in estimate) throw new Error(estimate.error);
  // 234 hours since Dec 1: compute, 600 GiB gp3 for 234/730 of a month, one IPv4.
  expect(estimate.monthToDate).toBeCloseTo(
    234 * 0.4032 + (600 * 0.08 * 234) / 730 + 234 * 0.005,
    2,
  );
  const remaining = (Date.UTC(2026, 11, 23, 7, 59) - fixtureNow) / 3600000;
  expect(estimate.forecast).toBeCloseTo(
    estimate.monthToDate +
      remaining * 0.4032 +
      (600 * 0.08 * remaining) / 730 +
      remaining * 0.005,
    2,
  );
  expect(estimate.storageGib).toBe(600);
  expect(estimate.publicIpv4).toBe(1);
});

test("the estimate counts compute only from a start inside the month", () => {
  const started = {
    ...fixtureSpend,
    instance: { ...fixtureSpend.instance, launch_time: "2026-12-05T00:00:00Z" },
  };
  const estimate = estimateSpend(started, fixtureConfig, fixtureNow);
  if ("error" in estimate) throw new Error(estimate.error);
  expect(estimate.computeSince).toBe(Date.UTC(2026, 11, 5));
  expect(estimate.monthToDate).toBeCloseTo(
    138 * 0.4032 + (600 * 0.08 * 234) / 730 + 234 * 0.005,
    2,
  );
});

test("the estimate counts each public IPv4 address once", () => {
  const reading = {
    ...fixtureSpend,
    addresses: [
      { public_ip: "198.51.100.7", allocation_id: "eipalloc-1" },
      { public_ip: "198.51.100.8", allocation_id: "eipalloc-2" },
    ],
  };
  const estimate = estimateSpend(reading, fixtureConfig, fixtureNow);
  if ("error" in estimate) throw new Error(estimate.error);
  expect(estimate.publicIpv4).toBe(2);
});

test("the estimate is not available without a price or while stopped", () => {
  const larger = {
    ...fixtureSpend,
    instance: { ...fixtureSpend.instance, type: "m7i.4xlarge" },
  };
  expect(estimateSpend(larger, fixtureConfig, fixtureNow)).toEqual({
    error: "no price for m7i.4xlarge in health.json",
  });
  const io2 = {
    ...fixtureSpend,
    volumes: [{ id: "v", type: "io2", size_gib: 10 }],
  };
  expect(estimateSpend(io2, fixtureConfig, fixtureNow)).toEqual({
    error: "no price for io2 volumes in health.json",
  });
  const stopped = {
    ...fixtureSpend,
    instance: { ...fixtureSpend.instance, state: "stopped" },
  };
  expect(estimateSpend(stopped, fixtureConfig, fixtureNow)).toEqual({
    error: "the host is stopped; its running hours this month are unknown",
  });
});

test("the view lists the sections in order with aligned label rows", () => {
  const lines = healthLines(fixtureModel(), 96);
  const titles = lines
    .filter((line) => line[0]?.tone === "title")
    .map((line) => line[0].text);
  expect(titles).toEqual([
    "Workstation",
    "Spend",
    "Workbench limits",
    "Storage",
    "Network",
  ]);
  const all = text(lines);
  expect(all).toContain("i-0123456789abcdef0 · m7i.2xlarge · us-east-1");
  expect(all).toContain("3d 4h 12m");
  expect(all).toContain("12 days left");
  expect(all).toContain("Ends Dec 22, 2026 at 11:59pm (UTC-8)");
  expect(all).toContain("Month to date:");
  expect(all).toContain("$110.91");
  expect(all).toContain("$254.03 by Dec 22 · 73% of budget");
  expect(all).toContain("25% of 6 cores");
  expect(all).toContain("20.0 of 24.0 GiB");
  expect(all).toContain("212 of 4096");
  expect(all).toContain("142.3 of 500.0 GiB");
  expect(all).toContain("1.2 MiB/s now · 48.3 GiB since boot");
  expect(all).toContain("220 KiB/s now · 9.1 GiB since boot");
  expect(all).toContain("12s ago");
  expect(all).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  // Values of label rows and bars start in one column.
  const starts = [
    "Uptime:",
    "Spent so far:",
    "Forecast:",
    "Month to date:",
    "CPU",
    "State disk",
  ].map((label) => {
    const line = lineText(row(lines, label));
    return (
      line.length -
      line.slice(line.indexOf(label) + label.length).trimStart().length
    );
  });
  expect(new Set(starts).size).toBe(1);
});

/** The rows of the Spend section, without its title. */
const spendRows = (lines: Span[][]) => {
  const start = lines.findIndex((line) => line[0]?.text === "Spend");
  const end = lines.findIndex((line) => line[0]?.text === "Workbench limits");
  return lines.slice(start + 1, end).filter((line) => lineText(line).trim());
};
const withBudget = (budget_usd: number, prior_spend_usd = 0) =>
  fixtureModel({ config: { ...fixtureConfig, budget_usd, prior_spend_usd } });

test("the budget bar shows spend so far; the forecast is a number with its share", () => {
  const rows = spendRows(healthLines(withBudget(350, 20), 96)).map(lineText);
  // Spent so far is the earlier spend from health.json plus the month to date.
  expect(rows[0]).toMatch(/^  Spent so far: +\$130\.91 of \$350 budget$/);
  expect(rows[1]).toMatch(/^ {18}━+╸?─+  37%$/);
  expect(rows[2]).toMatch(/^  Forecast: +\$274\.03 by Dec 22 · 78% of budget$/);
  expect(rows[3]).toMatch(/^  Month to date: +\$110\.91$/);
  expect(rows[4]).toMatch(/^ {18}Compute since/);
  // The bar measures spend so far: 37 % of 50 cells is 18.5 cells.
  const lines = healthLines(withBudget(350, 20), 112);
  const bar = spendRows(lines)[1].filter((span) => span.bar);
  expect(bar[0].text).toBe("━".repeat(18) + "╸");
  expect(bar[0].tone).toBe("accent");
});

test("the forecast turns amber at 95 percent of the budget and soft orange above it", () => {
  const forecast = (budget: number) =>
    row(healthLines(withBudget(budget), 96), "Forecast:").at(-1)!;
  // The fixture forecast is $254.03.
  expect(forecast(350).tone).toBe("value");
  expect(forecast(267).text).toContain("95% of budget");
  expect(forecast(267).tone).toBe("warning");
  // A forecast that equals the budget reaches it and does not exceed it.
  const exact = estimateSpend(fixtureSpend, fixtureConfig, fixtureNow);
  expect(forecast((exact as { forecast: number }).forecast).tone).toBe(
    "warning",
  );
  expect(forecast(250).text).toContain("102% of budget");
  expect(forecast(250).tone).toBe("critical");
});

test("the spend bar keeps the bar thresholds at 80 and 95 percent", () => {
  const barTone = (budget: number) =>
    spendRows(healthLines(withBudget(budget), 96))[1].find((span) => span.bar)!
      .tone;
  // Spend so far in the fixture is $110.91.
  expect(barTone(350)).toBe("accent");
  expect(barTone(130)).toBe("warning");
  expect(barTone(115)).toBe("critical");
});

test("without a spend reading every Spend row says why", () => {
  const rows = spendRows(
    healthLines(fixtureModel({ spend: undefined, spendError: "offline" }), 96),
  ).map(lineText);
  for (const label of ["Spent so far:", "Forecast:", "Month to date:"])
    expect(
      rows.some(
        (r) => r.includes(label) && r.includes("not available (offline)"),
      ),
    ).toBe(true);
});

test("bars change to warning at 80 percent and critical at 95 percent", () => {
  const lines = healthLines(fixtureModel(), 96);
  const barTone = (label: string) =>
    row(lines, label).find((span) => span.text.includes("━"))!.tone;
  expect(barTone("CPU")).toBe("accent");
  expect(barTone("Memory")).toBe("warning");
  expect(barTone("Cache disk")).toBe("critical");
  expect(barTone("State disk")).toBe("accent");
});

test("each bar is a heavy filled line on a dim thin track", () => {
  const lines = healthLines(fixtureModel(), 112);
  const spans = row(lines, "CPU").filter((span) => span.bar);
  // CPU is 25 % of a 50-cell bar: 12.5 cells, drawn as 12 heavy cells and a half-cell end.
  expect(spans.map((s) => s.text)).toEqual([
    "━".repeat(12) + "╸",
    "─".repeat(37),
  ]);
  expect(spans[0].tone).toBe("accent");
  expect(spans[1].tone).toBe("track");
  for (const line of lines)
    for (const span of line) expect(span.text).not.toMatch(/[█▏▎▍▌▋▊▉]/);
});

test("a full bar has no track and a tiny reading still shows", () => {
  const sample = structuredClone(fixtureSample);
  const workbench = sample.host!.workbench as { tasks: number };
  workbench.tasks = 1;
  const lines = healthLines(fixtureModel({ sample }), 112);
  const tasks = row(lines, "Tasks").filter((span) => span.bar);
  expect(tasks[0].text).toBe("╸");
  const spent = healthLines(fixtureModel(), 112);
  const bar = spent[spent.indexOf(row(spent, "Spent so far:")) + 1];
  expect(lineText(bar)).toContain("━");
});

test("a sample from the older host script shows the new sections as not available", () => {
  const { host: _, ...older } = fixtureSample;
  const all = text(healthLines(fixtureModel({ sample: older }), 96));
  const reason = "not available (host health script is older)";
  expect(all.split(reason).length - 1).toBe(4);
  expect(all).not.toContain("0%");
});

test("missing readings and failed parts give a reason, never a zero", () => {
  const all = text(
    healthLines(
      fixtureModel({
        sample: undefined,
        spend: undefined,
        spendError: "AWS authentication failed",
      }),
      96,
    ),
  );
  expect(all).toContain("not available (no health reading yet)");
  expect(all).toContain("not available (AWS authentication failed)");
  expect(all).not.toMatch(/\$0\.00|0% /);
  const partial = structuredClone(fixtureSample);
  partial.host!.network = { error: "PermissionError" };
  expect(text(healthLines(fixtureModel({ sample: partial }), 96))).toContain(
    "not available (PermissionError)",
  );
});

test("an invalid configuration shows its error in the view", () => {
  const all = text(
    healthLines(
      fixtureModel({
        configError: "health.json: budget_usd must be a positive number",
      }),
      96,
    ),
  );
  expect(all).toContain("health.json: budget_usd must be a positive number");
  expect(all).toContain("not available (configuration is invalid)");
});

test("narrow widths shorten the bars and keep every label whole", () => {
  const wide = healthLines(fixtureModel(), 112);
  const narrow = healthLines(fixtureModel(), 58);
  const barLength = (lines: Span[][]) =>
    row(lines, "CPU")
      .filter((span) => span.bar)
      .reduce((sum, span) => sum + span.text.length, 0);
  expect(barLength(narrow)).toBeLessThan(barLength(wide));
  expect(barLength(wide)).toBeLessThanOrEqual(50);
  for (const line of narrow)
    expect(lineText(line).length).toBeLessThanOrEqual(58);
  const all = text(narrow);
  for (const label of [
    "Authorization:",
    "Month to date:",
    "State disk",
    "Cache disk",
    "Received:",
    "142.3 of 500.0 GiB",
  ])
    expect(all).toContain(label);
});

test("the forecast date uses the offset of the authorization end", () => {
  const all = text(healthLines(fixtureModel(), 96));
  expect(all).toContain("by Dec 22");
});

test("narrow widths wrap the estimate note from the row indent", () => {
  const narrow = healthLines(fixtureModel(), 58);
  const note = narrow.filter((line) =>
    /Excludes|List prices|compute since/.test(lineText(line)),
  );
  expect(note.length).toBeGreaterThan(0);
  for (const line of note) expect(lineText(line).startsWith("  ")).toBe(true);
  expect(lineText(note[0]).startsWith("   ")).toBe(false);
});

test("short heights drop the blank lines between sections", () => {
  const tall = healthLines(fixtureModel(), 96, 40);
  const short = healthLines(fixtureModel(), 96, 24);
  expect(tall.filter((line) => !lineText(line).trim()).length).toBeGreaterThan(
    0,
  );
  expect(short.filter((line) => !lineText(line).trim()).length).toBe(0);
});
