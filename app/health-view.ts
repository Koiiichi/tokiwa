/** Plain-text Health view: configuration, spend estimate and the line layout. */
import { readFileSync } from "node:fs";
import type { HealthSample } from "./backend";

export interface HealthConfig {
  /** Without a budget, Spend shows amounts only, with no bar and no share. */
  budget_usd?: number;
  /** Without an end, the forecast runs to the end of the month and Host shows no end row. */
  authorization_end?: string;
  prior_spend_usd: number;
  prices: {
    instance_hour: Record<string, number>;
    volume_gb_month: Record<string, number>;
    public_ipv4_hour: number;
  };
}
/** The keys that health.json may hold. */
export const HEALTH_KEYS = [
  "budget_usd",
  "authorization_end",
  "prior_spend_usd",
  "prices",
] as const;
/** No budget, no end and no instance price: health.json sets them for a host. */
export const DEFAULT_CONFIG: HealthConfig = Object.freeze({
  prior_spend_usd: 0,
  prices: {
    instance_hour: {},
    volume_gb_month: { gp3: 0.08 },
    public_ipv4_hour: 0.005,
  },
});

const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isAmount = (v: unknown, positive = false): v is number =>
  typeof v === "number" && Number.isFinite(v) && (positive ? v > 0 : v >= 0);
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function rates(value: unknown, name: string) {
  if (!isObject(value)) throw new Error(`${name} must be an object`);
  for (const [key, rate] of Object.entries(value))
    if (!isAmount(rate)) throw new Error(`${name}.${key} must be a number`);
  return value as Record<string, number>;
}

/** Merge a parsed health.json over the defaults; throw an Error that names the first bad field. */
export function parseHealthConfig(value: unknown): HealthConfig {
  if (!isObject(value)) throw new Error("the file must hold one JSON object");
  for (const key of Object.keys(value))
    if (!(HEALTH_KEYS as readonly string[]).includes(key))
      throw new Error(`unknown key ${key}`);
  const config = structuredClone(DEFAULT_CONFIG) as HealthConfig;
  if ("budget_usd" in value) {
    if (!isAmount(value.budget_usd, true))
      throw new Error("budget_usd must be a positive number");
    config.budget_usd = value.budget_usd;
  }
  if ("prior_spend_usd" in value) {
    if (!isAmount(value.prior_spend_usd))
      throw new Error("prior_spend_usd must be zero or a positive number");
    config.prior_spend_usd = value.prior_spend_usd;
  }
  if ("authorization_end" in value) {
    const end = value.authorization_end;
    if (
      typeof end !== "string" ||
      !ISO_WITH_OFFSET.test(end) ||
      !Number.isFinite(Date.parse(end))
    )
      throw new Error(
        "authorization_end must be an ISO 8601 time with an offset, for example 2026-12-31T23:59:00-08:00",
      );
    config.authorization_end = end;
  }
  if ("prices" in value) {
    const prices = value.prices;
    if (!isObject(prices)) throw new Error("prices must be an object");
    for (const key of Object.keys(prices))
      if (!(key in config.prices)) throw new Error(`unknown key prices.${key}`);
    if ("instance_hour" in prices)
      Object.assign(
        config.prices.instance_hour,
        rates(prices.instance_hour, "prices.instance_hour"),
      );
    if ("volume_gb_month" in prices)
      Object.assign(
        config.prices.volume_gb_month,
        rates(prices.volume_gb_month, "prices.volume_gb_month"),
      );
    if ("public_ipv4_hour" in prices) {
      if (!isAmount(prices.public_ipv4_hour))
        throw new Error("prices.public_ipv4_hour must be a number");
      config.prices.public_ipv4_hour = prices.public_ipv4_hour;
    }
  }
  return config;
}

/** Read health.json. A missing file gives the defaults; any other problem gives the defaults and an error line. */
export function loadHealthConfig(path: string): {
  config: HealthConfig;
  error?: string;
} {
  const home = process.env.HOME;
  const shown =
    home && path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { config: DEFAULT_CONFIG };
    return { config: DEFAULT_CONFIG, error: `${shown} cannot be read` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { config: DEFAULT_CONFIG, error: `${shown} is not valid JSON` };
  }
  try {
    return { config: parseHealthConfig(value) };
  } catch (e) {
    return {
      config: DEFAULT_CONFIG,
      error: `${shown}: ${(e as Error).message}`,
    };
  }
}

export interface SpendReading {
  instance_id: string;
  region: string;
  read_at: number;
  instance: {
    type: string;
    state: string;
    launch_time: string;
    public_ip?: string | null;
  };
  volumes: { id: string; type: string; size_gib: number }[];
  addresses: { public_ip: string }[];
}

/** Validate the JSON object that `tokiwa spend` prints. */
export function spendReading(value: unknown): SpendReading {
  const s = value as SpendReading;
  const ok =
    isObject(s) &&
    typeof s.instance_id === "string" &&
    typeof s.region === "string" &&
    isAmount(s.read_at) &&
    isObject(s.instance) &&
    typeof s.instance.type === "string" &&
    typeof s.instance.state === "string" &&
    typeof s.instance.launch_time === "string" &&
    Number.isFinite(Date.parse(s.instance.launch_time)) &&
    (s.instance.public_ip == null ||
      typeof s.instance.public_ip === "string") &&
    Array.isArray(s.volumes) &&
    s.volumes.length <= 50 &&
    s.volumes.every(
      (v) => isObject(v) && typeof v.type === "string" && isAmount(v.size_gib),
    ) &&
    Array.isArray(s.addresses) &&
    s.addresses.length <= 50 &&
    s.addresses.every((a) => isObject(a) && typeof a.public_ip === "string");
  if (!ok) throw new Error("The spend reading is invalid.");
  return s;
}

export interface SpendEstimate {
  monthToDate: number;
  forecast: number;
  /** The forecast as a share of the budget; none without a budget. */
  percent?: number;
  monthStart: number;
  computeSince: number;
  end: number;
  storageGib: number;
  publicIpv4: number;
}

const HOUR = 3600000;
// AWS prorates GB-month storage prices over 730 hours.
const MONTH_HOURS = 730;

/**
 * Estimate spend at list prices. Compute counts from the later of the UTC month start and the last
 * start; storage and public IPv4 count from the month start. The forecast assumes that the host keeps
 * running with the same volumes and addresses until the authorization end.
 */
export function estimateSpend(
  reading: SpendReading,
  config: HealthConfig,
  now: number,
): SpendEstimate | { error: string } {
  const { prices } = config;
  const hourly = prices.instance_hour[reading.instance.type];
  if (hourly === undefined)
    return { error: `no price for ${reading.instance.type} in health.json` };
  let storageMonthly = 0;
  for (const volume of reading.volumes) {
    const rate = prices.volume_gb_month[volume.type];
    if (rate === undefined)
      return { error: `no price for ${volume.type} volumes in health.json` };
    storageMonthly += volume.size_gib * rate;
  }
  if (reading.instance.state !== "running")
    return {
      error: `the host is ${reading.instance.state}; its running hours this month are unknown`,
    };
  const today = new Date(now);
  const monthStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1);
  const computeSince = Math.max(
    monthStart,
    Date.parse(reading.instance.launch_time),
  );
  // Without an authorization end, forecast to the start of the next month (UTC).
  const end = config.authorization_end
    ? Date.parse(config.authorization_end)
    : Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1);
  const publicIpv4 = new Set(
    [
      reading.instance.public_ip,
      ...reading.addresses.map((a) => a.public_ip),
    ].filter(Boolean),
  ).size;
  const elapsed = (now - monthStart) / HOUR;
  const remaining = Math.max(0, (end - now) / HOUR);
  const fixedHourly =
    storageMonthly / MONTH_HOURS + publicIpv4 * prices.public_ipv4_hour;
  const monthToDate =
    ((now - computeSince) / HOUR) * hourly + elapsed * fixedHourly;
  const forecast =
    config.prior_spend_usd + monthToDate + remaining * (hourly + fixedHourly);
  return {
    monthToDate,
    forecast,
    ...(config.budget_usd ? { percent: (100 * forecast) / config.budget_usd } : {}),
    monthStart,
    computeSince,
    end,
    storageGib: reading.volumes.reduce((sum, v) => sum + v.size_gib, 0),
    publicIpv4,
  };
}

export type Tone =
  | "title"
  | "label"
  | "value"
  | "dim"
  | "accent"
  | "memory"
  | "warning"
  | "critical"
  | "track";
/** One run of text in one tone. `bar` marks the cells of a bar: its fill and its track. */
export interface Span {
  text: string;
  tone: Tone;
  bar?: boolean;
  /** In the shortcuts sheet, the id of the key map binding that the span shows. */
  binding?: string;
}
export interface HealthViewModel {
  now: number;
  sample?: HealthSample;
  status: string;
  error: string;
  spend?: SpendReading;
  spendError: string;
  config: HealthConfig;
  configError: string;
}
export const lineText = (line: Span[]) => line.map((s) => s.text).join("");

type Row =
  | { kind: "title"; text: string; note?: string }
  | { kind: "pair"; label: string; value: string; tone?: Tone }
  | {
      kind: "bar";
      label: string;
      value: string;
      percent?: number;
      tone?: Tone;
    }
  | {
      kind: "note";
      text: string;
      tone?: Tone;
      at?: "start" | "indent" | "value";
    };

const INDENT = 2;
const LABEL = 16;
const GAP = 2;
const BAR_MAX = 50;
const BAR_MIN = 6;
const GiB = 1024 ** 3;
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

const missing = (reason: string) => `not available (${reason})`;
const money = (usd: number) => `$${usd.toFixed(2)}`;
const gib = (bytes: number) => (bytes / GiB).toFixed(1);
const cores = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const day = (ms: number) => {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
const severity = (percent: number, normal: Tone): Tone =>
  percent >= 95 ? "critical" : percent >= 80 ? "warning" : normal;

export function formatBytes(bytes: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit && value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function age(seconds: number) {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/** Shift an ISO time with an offset so that its UTC fields read as the time in that offset. */
function inOffset(iso: string) {
  const offset = /(Z|([+-])(\d{2}):(\d{2}))$/.exec(iso)!;
  const minutes =
    offset[1] === "Z"
      ? 0
      : (offset[2] === "-" ? -1 : 1) * (+offset[3] * 60 + +offset[4]);
  return { local: new Date(Date.parse(iso) + minutes * 60000), minutes };
}

function endText(iso: string) {
  const { local, minutes } = inOffset(iso);
  const hour = local.getUTCHours() % 12 || 12;
  const minute = local.getUTCMinutes();
  const clock = `${hour}${minute ? `:${String(minute).padStart(2, "0")}` : ""}${local.getUTCHours() < 12 ? "am" : "pm"}`;
  const size = Math.abs(minutes);
  const zone = minutes
    ? `UTC${minutes < 0 ? "-" : "+"}${Math.floor(size / 60)}${size % 60 ? `:${String(size % 60).padStart(2, "0")}` : ""}`
    : "UTC";
  return `Ends ${day(local.getTime())}, ${local.getUTCFullYear()} at ${clock} (${zone})`;
}

export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    let rest = word;
    while (rest.length > width) {
      if (line) lines.push(line);
      line = "";
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= width) line += " " + rest;
    else {
      lines.push(line);
      line = rest;
    }
  }
  lines.push(line);
  return lines;
}

function workstation(m: HealthViewModel, valueWidth: number): Row[] {
  const rows: Row[] = [{ kind: "title", text: "Workstation" }];
  if (m.spend) {
    const { instance_id, instance, region } = m.spend;
    const state = instance.state === "running" ? "" : ` · ${instance.state}`;
    const tone = state ? "warning" : undefined;
    const joined = `${instance_id} · ${instance.type} · ${region}${state}`;
    if (joined.length <= valueWidth)
      rows.push({ kind: "pair", label: "Instance:", value: joined, tone });
    else
      rows.push(
        { kind: "pair", label: "Instance:", value: instance_id },
        {
          kind: "pair",
          label: "Type:",
          value: `${instance.type} · ${region}${state}`,
          tone,
        },
      );
  } else
    rows.push({
      kind: "pair",
      label: "Instance:",
      value: missing(m.spendError || "no AWS reading yet"),
      tone: "dim",
    });
  const host = m.sample?.host;
  const uptime = !m.sample
    ? missing("no health reading yet")
    : !host
      ? missing("host health script is older")
      : typeof host.uptime_seconds === "number"
        ? formatDuration(host.uptime_seconds)
        : missing("uptime is unreadable");
  rows.push({
    kind: "pair",
    label: "Uptime:",
    value: uptime,
    tone: uptime.startsWith("not") ? "dim" : undefined,
  });
  if (m.configError)
    rows.push({
      kind: "pair",
      label: "Authorization:",
      value: missing("configuration is invalid"),
      tone: "dim",
    });
  else if (m.config.authorization_end) {
    const left = (Date.parse(m.config.authorization_end) - m.now) / 86400000;
    const days = Math.floor(left);
    rows.push(
      {
        kind: "pair",
        label: "Authorization:",
        value:
          left <= 0
            ? "ended"
            : days < 1
              ? "less than 1 day left"
              : `${days} ${days === 1 ? "day" : "days"} left`,
        tone: left < 1 ? "critical" : left <= 7 ? "warning" : undefined,
      },
      { kind: "note", text: endText(m.config.authorization_end) },
    );
  }
  return rows;
}

function spend(m: HealthViewModel): Row[] {
  const rows: Row[] = [{ kind: "title", text: "Spend", note: " (estimate)" }];
  const unavailable = (reason: string) => {
    for (const label of ["Spent so far:", "Forecast:", "Month to date:"])
      rows.push({ kind: "pair", label, value: missing(reason), tone: "dim" });
    return rows;
  };
  if (m.configError) {
    rows.push({
      kind: "note",
      text: m.configError,
      tone: "critical",
      at: "indent",
    });
    return unavailable("configuration is invalid");
  }
  if (!m.spend) return unavailable(m.spendError || "no AWS reading yet");
  const estimate = estimateSpend(m.spend, m.config, m.now);
  if ("error" in estimate) return unavailable(estimate.error);
  const since =
    estimate.computeSince > estimate.monthStart
      ? `the last start on ${day(estimate.computeSince)}`
      : day(estimate.monthStart);
  const earlier = m.config.prior_spend_usd
    ? `Includes ${money(m.config.prior_spend_usd)} of earlier spend from health.json. Excludes data transfer, snapshots and tax.`
    : `Excludes spend before ${day(estimate.monthStart)}, data transfer, snapshots and tax.`;
  const addresses = `${estimate.publicIpv4} public IPv4`;
  const budget = m.config.budget_usd;
  const spent = m.config.prior_spend_usd + estimate.monthToDate;
  const until = m.config.authorization_end
    ? day(inOffset(m.config.authorization_end).local.getTime())
    : day(estimate.end - 1);
  if (budget) {
    const share = (100 * spent) / budget;
    rows.push(
      {
        kind: "pair",
        label: "Spent so far:",
        value: `${money(spent)} of $${budget} budget`,
      },
      { kind: "bar", label: "", percent: share, value: `${Math.round(share)}%` },
    );
  } else
    rows.push({ kind: "pair", label: "Spent so far:", value: money(spent) });
  const percent = estimate.percent;
  rows.push(
    {
      kind: "pair",
      label: "Forecast:",
      value:
        percent === undefined
          ? `${money(estimate.forecast)} by ${until}`
          : `${money(estimate.forecast)} by ${until} · ${Math.round(percent)}% of budget`,
      // The forecast warns from 95 % of the budget and is critical above the budget.
      tone:
        percent === undefined
          ? undefined
          : percent > 100
            ? "critical"
            : percent >= 95
              ? "warning"
              : undefined,
    },
    {
      kind: "pair",
      label: "Month to date:",
      value: money(estimate.monthToDate),
    },
    {
      kind: "note",
      text: `Compute since ${since}, ${estimate.storageGib} GiB of EBS and ${addresses} at list prices, if the host keeps running. ${earlier}`,
    },
  );
  return rows;
}

function hostSection(
  m: HealthViewModel,
  title: string,
  build: (host: NonNullable<HealthSample["host"]>) => Row[],
  note?: string,
): Row[] {
  const head: Row = { kind: "title", text: title, note };
  const host = m.sample?.host;
  const reason = !m.sample
    ? "no health reading yet"
    : !host
      ? "host health script is older"
      : "";
  if (reason)
    return [
      head,
      { kind: "note", text: missing(reason), tone: "dim", at: "indent" },
    ];
  try {
    return [head, ...build(host!)];
  } catch (e) {
    return [
      head,
      {
        kind: "note",
        text: missing((e as Error).message),
        tone: "dim",
        at: "indent",
      },
    ];
  }
}

const failure = (part: unknown) =>
  part && typeof part === "object" && "error" in part
    ? String((part as { error: unknown }).error)
    : "";

function limits(m: HealthViewModel): Row[] {
  return hostSection(m, "Workbench limits", (host) => {
    const w = host.workbench;
    if (failure(w)) throw new Error(failure(w));
    if (!w || !("unit" in w)) throw new Error("no workbench reading");
    const cpu = w.cpu_quota_cores
      ? (100 * w.cpu_used_cores) / w.cpu_quota_cores
      : undefined;
    const memory = w.memory_max_bytes
      ? (100 * w.memory_bytes) / w.memory_max_bytes
      : undefined;
    const tasks = w.tasks_max ? (100 * w.tasks) / w.tasks_max : undefined;
    return [
      {
        kind: "bar",
        label: "CPU",
        percent: cpu,
        value:
          cpu === undefined
            ? `${w.cpu_used_cores.toFixed(1)} cores (no quota)`
            : `${Math.round(cpu)}% of ${cores(w.cpu_quota_cores!)} cores`,
      },
      {
        kind: "bar",
        label: "Memory",
        percent: memory,
        tone: "memory",
        value:
          memory === undefined
            ? `${gib(w.memory_bytes)} GiB (no limit)`
            : `${gib(w.memory_bytes)} of ${gib(w.memory_max_bytes!)} GiB`,
      },
      {
        kind: "bar",
        label: "Tasks",
        percent: tasks,
        value:
          tasks === undefined
            ? `${w.tasks} (no limit)`
            : `${w.tasks} of ${w.tasks_max}`,
      },
    ];
  });
}

function storage(m: HealthViewModel): Row[] {
  return hostSection(m, "Storage", (host) => {
    if (!Array.isArray(host.storage) || !host.storage.length)
      throw new Error("no storage reading");
    return host.storage.map((disk): Row => {
      if (failure(disk) || !("used_bytes" in disk))
        return {
          kind: "bar",
          label: disk.label,
          value: missing(failure(disk) || "invalid reading"),
          tone: "dim",
        };
      // Like df, count the root-reserved blocks as unavailable rather than free.
      const percent =
        (100 * disk.used_bytes) / (disk.used_bytes + disk.free_bytes);
      return {
        kind: "bar",
        label: disk.label,
        percent,
        value: `${gib(disk.used_bytes)} of ${gib(disk.total_bytes)} GiB`,
      };
    });
  });
}

function network(m: HealthViewModel): Row[] {
  const net = m.sample?.host?.network;
  const name = net && "interface" in net ? ` · ${net.interface}` : undefined;
  return hostSection(
    m,
    "Network",
    () => {
      if (!net) throw new Error("not sampled");
      if (failure(net) || !("interface" in net))
        throw new Error(failure(net) || "invalid reading");
      return [
        {
          kind: "pair",
          label: "Received:",
          value: `${formatBytes(net.rx_bytes_per_second)}/s now · ${formatBytes(net.rx_bytes)} since boot`,
        },
        {
          kind: "pair",
          label: "Sent:",
          value: `${formatBytes(net.tx_bytes_per_second)}/s now · ${formatBytes(net.tx_bytes)} since boot`,
        },
      ];
    },
    name,
  );
}

function footer(m: HealthViewModel): Row[] {
  const rows: Row[] = [];
  const sample = m.sample;
  if (sample) {
    const time = new Date(sample.sampled_at * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const state = m.status === "live" ? "" : ` · ${m.status}`;
    rows.push({
      kind: "note",
      text: `Sampled ${time} · ${age(m.now / 1000 - sample.sampled_at)}${state}`,
      tone: m.status === "stale" ? "warning" : "dim",
      at: "start",
    });
  } else
    rows.push({
      kind: "note",
      text: "Waiting for the first health reading",
      tone: "dim",
      at: "start",
    });
  if (m.error)
    rows.push({
      kind: "note",
      text: `Last read failed: ${m.error}`,
      tone: "warning",
      at: "start",
    });
  return rows;
}

/**
 * Draw a bar as a heavy line for the filled part and a thin line for the track. The fill has
 * half-cell resolution; a reading above zero always shows at least the half-cell end piece.
 */
function barSpans(percent: number, width: number, tone: Tone): Span[] {
  let halves = Math.round(
    (Math.min(100, Math.max(0, percent)) / 100) * width * 2,
  );
  if (percent > 0 && !halves) halves = 1;
  const fill = "━".repeat(Math.floor(halves / 2)) + (halves % 2 ? "╸" : "");
  const spans: Span[] = [];
  if (fill) spans.push({ text: fill, tone, bar: true });
  if (width - fill.length > 0)
    spans.push({
      text: "─".repeat(width - fill.length),
      tone: "track",
      bar: true,
    });
  return spans;
}

/**
 * Lay out the Health view as lines of styled spans for a content width in cells. Labels keep their
 * width; bars shrink. Blank lines separate sections only when the whole view fits in `height` rows.
 */
export function healthLines(
  m: HealthViewModel,
  width: number,
  height = Infinity,
): Span[][] {
  const valueColumn = INDENT + LABEL;
  const valueWidth = Math.max(8, width - valueColumn);
  const sections = [
    workstation(m, valueWidth),
    spend(m),
    limits(m),
    storage(m),
    network(m),
  ];
  const barValues = sections
    .flat()
    .filter((r): r is Extract<Row, { kind: "bar" }> => r.kind === "bar")
    .filter((r) => r.percent !== undefined)
    .map((r) => r.value.length);
  const barWidth = Math.max(
    BAR_MIN,
    Math.min(BAR_MAX, width - valueColumn - GAP - Math.max(0, ...barValues)),
  );
  const pad = " ".repeat(INDENT);
  const render = (row: Row): Span[][] => {
    switch (row.kind) {
      case "title":
        return [
          [
            { text: row.text, tone: "title" },
            ...(row.note ? [{ text: row.note, tone: "dim" as Tone }] : []),
          ],
        ];
      case "note": {
        // A narrow value column would stack the estimate note into many short lines.
        const start =
          row.at === "start"
            ? 0
            : row.at === "indent" ||
                (valueWidth < 60 && row.text.length > valueWidth)
              ? INDENT
              : valueColumn;
        return wrap(row.text, Math.max(8, width - start)).map((text) => [
          { text: " ".repeat(start) + text, tone: row.tone ?? "dim" },
        ]);
      }
      case "pair":
        return wrap(row.value, valueWidth).map((text, i) => [
          { text: pad + (i ? "" : row.label).padEnd(LABEL), tone: "label" },
          { text, tone: row.tone ?? "value" },
        ]);
      case "bar": {
        const head: Span = {
          text: pad + row.label.padEnd(LABEL),
          tone: "label",
        };
        if (row.percent === undefined)
          return wrap(row.value, valueWidth).map((text, i) => [
            i ? { ...head, text: " ".repeat(valueColumn) } : head,
            { text, tone: row.tone ?? "value" },
          ]);
        const tone = severity(row.percent, row.tone ?? "accent");
        return [
          [
            head,
            ...barSpans(row.percent, barWidth, tone),
            { text: " ".repeat(GAP), tone: "value" },
            {
              text: row.value,
              tone: tone === "warning" || tone === "critical" ? tone : "value",
            },
          ] as Span[],
        ];
      }
    }
  };
  const blocks = [...sections, footer(m)].map((rows) => rows.flatMap(render));
  const lines = blocks.flat();
  if (lines.length + blocks.length - 1 > height) return lines;
  return blocks.flatMap((block, i) =>
    i ? [[{ text: "", tone: "value" as Tone }], ...block] : block,
  );
}
