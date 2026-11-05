/** UI observations are transient. The remote snapshot remains authoritative. */
import { healthSample, type HealthSample } from "./backend";
export type Activity =
  "output" | "quiet" | "disconnected" | "exited" | "partial" | "unknown";
export function activity(
  remote: boolean,
  connected: boolean,
  lastOutput: number,
  partial = false,
  now = Date.now(),
): Activity {
  if (!connected) return remote ? "disconnected" : "exited";
  if (partial) return "partial";
  if (!lastOutput) return "unknown";
  return now - lastOutput < 2000 ? "output" : "quiet";
}
/** Bounded Health readings and read events. Sampling has no attempt cap; closing the app stops it. */
export class HealthHistory {
  static readonly limit = 120;
  readonly samples: HealthSample[] = [];
  readonly events: { at: number; status: string; error: string }[] = [];
  error = "";
  gap = false;
  attempts = 0;
  stopped = false;
  recorded = false;
  add(value: unknown, now = Date.now() / 1000) {
    const s = healthSample(value);
    if (s.sampled_at > now + 5 || s.sampled_at < now - 120)
      throw new Error("The backend sample timestamp is stale.");
    if (this.samples.length && s.sampled_at <= this.samples.at(-1)!.sampled_at)
      throw new Error("The sample timestamp did not advance.");
    this.samples.push({ ...s, ...(this.gap ? { gap_before: true } : {}) });
    this.gap = false;
    if (this.samples.length > HealthHistory.limit) this.samples.shift();
    this.error = s.errors.join("; ");
  }
  /** Show one recorded reading of any age. A recorded history never samples. */
  load(value: unknown) {
    this.samples.splice(0, this.samples.length, healthSample(value));
    this.recorded = this.stopped = true;
  }
  status(now = Date.now() / 1000) {
    if (this.recorded) return "recorded";
    if (this.error) return this.samples.length ? "partial" : "error";
    if (!this.samples.length) return "unknown";
    if (now - this.samples.at(-1)!.sampled_at > 65) return "stale";
    return "live";
  }
  async sample(read: () => Promise<HealthSample>) {
    if (this.stopped) return;
    this.attempts++;
    try {
      this.add(await read());
    } catch (e) {
      this.error = String(e);
      this.gap = true;
    }
    this.events.push({
      at: Date.now() / 1000,
      status: this.status(),
      error: this.error,
    });
    if (this.events.length > HealthHistory.limit) this.events.shift();
  }
}

export class WorkspaceState {
  view: "health" | "shell" = "health";
  active = 0;
  selection = 0;
  error = "";
}
