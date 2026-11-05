/** A fixed Health reading for tests and text captures. Every value is invented. */
import type { HealthSample } from "./backend";
import { type HealthConfig, type HealthViewModel } from "./health-view";

const GiB = 1024 ** 3;
/** A health.json for tests: a budget, an end and a price for the fixture instance. */
export const fixtureConfig: HealthConfig = Object.freeze({
  budget_usd: 350,
  authorization_end: "2026-12-22T23:59:00-08:00",
  prior_spend_usd: 0,
  prices: {
    instance_hour: { "m7i.2xlarge": 0.4032 },
    volume_gb_month: { gp3: 0.08 },
    public_ipv4_hour: 0.005,
  },
});
export const fixtureNow = Date.UTC(2026, 11, 10, 18, 0, 12);
export const fixtureSample: HealthSample = {
  sampled_at: Date.UTC(2026, 11, 10, 18, 0, 0) / 1000,
  metrics: { cpu_percent: 21.4, ram_percent: 48.2 },
  rows: [["Root disk", "76.6 GiB free / 100.0 GiB"]],
  errors: [],
  host: {
    uptime_seconds: 3 * 86400 + 4 * 3600 + 12 * 60 + 9,
    workbench: {
      unit: "cloud-workbench.service",
      cpu_used_cores: 1.5,
      cpu_quota_cores: 6,
      memory_bytes: 20 * GiB,
      memory_max_bytes: 24 * GiB,
      tasks: 212,
      tasks_max: 4096,
    },
    storage: [
      {
        label: "State disk",
        path: "/srv/development/state",
        total_bytes: 500 * GiB,
        used_bytes: 142.3 * GiB,
        free_bytes: 357.7 * GiB,
      },
      {
        label: "Cache disk",
        path: "/srv/development/cache",
        total_bytes: 200 * GiB,
        used_bytes: 191 * GiB,
        free_bytes: 9 * GiB,
      },
      {
        label: "Root disk",
        path: "/",
        total_bytes: 100 * GiB,
        used_bytes: 23.4 * GiB,
        free_bytes: 76.6 * GiB,
      },
    ],
    network: {
      interface: "ens5",
      rx_bytes: 48.3 * GiB,
      tx_bytes: 9.1 * GiB,
      rx_bytes_per_second: 1.2 * 1024 ** 2,
      tx_bytes_per_second: 220 * 1024,
    },
  },
};
export const fixtureSpend = {
  instance_id: "i-0123456789abcdef0",
  region: "us-east-1",
  read_at: Date.UTC(2026, 11, 10, 17, 58) / 1000,
  instance: {
    type: "m7i.2xlarge",
    state: "running",
    launch_time: "2026-10-30T02:05:11+00:00",
    public_ip: "198.51.100.7",
    availability_zone: "us-east-1a",
  },
  volumes: [
    { id: "vol-0a", type: "gp3", size_gib: 100 },
    { id: "vol-0b", type: "gp3", size_gib: 500 },
  ],
  addresses: [],
};
export function fixtureModel(
  overrides: Partial<HealthViewModel> = {},
): HealthViewModel {
  return {
    now: fixtureNow,
    sample: fixtureSample,
    status: "live",
    error: "",
    spend: fixtureSpend,
    spendError: "",
    config: fixtureConfig,
    configError: "",
    ...overrides,
  };
}
