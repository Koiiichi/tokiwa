/** Delegate operational authority to the installed launcher. Never call AWS or tmux here. */
import { join } from "node:path";
import { spendReading } from "./health-view";
/** The launcher's message when a read fails because the AWS sign-in expired. */
export const SIGN_IN_EXPIRED =
  /AWS authentication failed|AWS login did not complete/;
export interface SessionRef {
  name: string;
  identity: string;
  cwd: string;
  project: string;
  clients: number;
  activity_partial?: boolean;
  /** One entry per pane, with a hash of its screen. The view compares hashes between snapshots. */
  activity?: { pane: string; dead: boolean; command: string; screen: string }[];
  /**
   * True when a window of the session rang the bell while no client viewed that window. A host
   * helper without this field gives false.
   */
  bell?: boolean;
  /**
   * The time, in seconds on the host, that a program in the session ran `tokiwa-attention`, or 0.
   * Unlike the bell, it stays while a client has the session open. An attach clears it.
   */
  attention?: number;
  /** The tmux session id (for example `$4`) of the session that this one was opened from. */
  parent?: string;
  /** True when Tokiwa made the session. A host helper without this field leaves it out. */
  managed?: boolean;
}
/**
 * A session that a program started for its own work, for example a watcher or a bridge. Tokiwa
 * did not make it and no agent runs in it, so it stays out of the owner's list.
 */
export function isBackground(ref: SessionRef) {
  return (
    ref.managed === false &&
    !ref.activity?.some((a) => /^(claude|codex)$/.test(a.command))
  );
}
/** A project saved on the workstation, so it shows also without sessions. */
export interface SavedProject {
  dir: string;
}
type Part<T> = T | { error: string };
/** Fields that newer host health scripts add. A part that the host cannot read carries its error. */
export interface HostUsage {
  uptime_seconds: number | null;
  workbench: Part<{
    unit: string;
    cpu_used_cores: number;
    cpu_quota_cores: number | null;
    memory_bytes: number;
    memory_max_bytes: number | null;
    tasks: number;
    tasks_max: number | null;
  }>;
  storage: ({ label: string; path: string } & Part<{
    total_bytes: number;
    used_bytes: number;
    free_bytes: number;
  }>)[];
  network: Part<{
    interface: string;
    rx_bytes: number;
    tx_bytes: number;
    rx_bytes_per_second: number;
    tx_bytes_per_second: number;
  }> | null;
  /** The sudo processes of connections that ended without them; they can spin at full CPU. */
  stuck_connections?: Part<
    { pid: number; cpu_seconds: number; age_seconds: number }[]
  >;
}
export interface HealthSample {
  sampled_at: number;
  metrics: { cpu_percent: number; ram_percent: number };
  rows: string[][];
  errors: string[];
  host?: HostUsage;
}
export type Runner = (args: string[]) => Promise<string>;
/** Check a project name path such as `studio/api`: one to six names of letters, digits, `.`, `_`, `-`. */
export function projectName(value: string) {
  const parts = value.split("/");
  if (
    parts.length > 6 ||
    !parts.every((p) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(p))
  )
    throw new Error(
      "Use a project name such as inbox or studio/api: letters, digits, dots, hyphens or underscores.",
    );
  return value;
}
export function sessionName(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(value))
    throw new Error("The session name is invalid.");
  return value;
}
export function healthSample(value: unknown): HealthSample {
  const s = value as HealthSample;
  if (
    !s ||
    !Number.isFinite(s.sampled_at) ||
    !s.metrics ||
    !Array.isArray(s.rows) ||
    s.rows.length > 50 ||
    !Array.isArray(s.errors)
  )
    throw new Error("The health response is invalid.");
  for (const v of [s.metrics.cpu_percent, s.metrics.ram_percent])
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100)
      throw new Error("The health metric is invalid.");
  if (
    !s.rows.every(
      (r) =>
        Array.isArray(r) &&
        r.length === 2 &&
        r.every((v) => typeof v === "string" && v.length < 1000),
    ) ||
    !s.errors.every((v) => typeof v === "string")
  )
    throw new Error("The health rows are invalid.");
  return s;
}
export class BackendClient {
  private children = new Set<ReturnType<typeof Bun.spawn>>();
  close() {
    for (const child of this.children) child.kill();
    this.children.clear();
  }
  constructor(
    readonly launcher = join(process.env.HOME!, ".local/bin/tokiwa"),
    private runner?: Runner,
  ) {}
  async call(args: string[]): Promise<string> {
    if (this.runner) return this.runner(args);
    const p = Bun.spawn([this.launcher, ...args], {
      env: { ...process.env, TOKIWA_DASHBOARD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    this.children.add(p);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, 90000);
    try {
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      if (out.length > 100000)
        throw new Error("The response exceeds the size limit.");
      if (timedOut) throw new Error("The launcher exceeded 90 seconds.");
      if (code !== 0)
        throw new Error(
          `Launcher ${args[0]} exited ${code}: ${err.trim().slice(-600) || out.trim().slice(-600) || "no diagnostic output"}`,
        );
      return out.trim();
    } finally {
      clearTimeout(timer);
      this.children.delete(p);
    }
  }
  /** The saved projects of the last snapshot, by name path. */
  projects: Record<string, SavedProject> = {};
  async sessions(): Promise<SessionRef[]> {
    const snapshot = JSON.parse(await this.call(["--snapshot"]));
    const rows = snapshot.sessions;
    const saved = snapshot.projects ?? {};
    if (typeof saved !== "object" || Array.isArray(saved))
      throw new Error("The saved projects are invalid.");
    this.projects = Object.fromEntries(
      Object.entries(saved).filter(
        ([path, p]: [string, any]) =>
          /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,300}$/.test(path) &&
          typeof p?.dir === "string",
      ),
    ) as Record<string, SavedProject>;
    if (!Array.isArray(rows) || rows.length > 100)
      throw new Error("The session snapshot is invalid.");
    for (const r of rows) {
      sessionName(r.name);
      if (
        !/^\d+:\$\d+:\d+$/.test(r.identity) ||
        typeof r.cwd !== "string" ||
        typeof r.project !== "string" ||
        !Number.isInteger(r.clients)
      )
        throw new Error("The session identity is invalid.");
      r.bell = r.bell === true;
      r.parent = typeof r.parent === "string" ? r.parent : "";
    }
    return rows;
  }
  async resolve(name: string, identity?: string) {
    const s = (await this.sessions()).find((s) => s.name === sessionName(name));
    if (!s)
      throw new Error(
        "The session no longer exists. No replacement was created.",
      );
    if (identity && s.identity !== identity)
      throw new Error("The session identity changed. Reconnect was refused.");
    return s;
  }
  attachCommand(ref: SessionRef) {
    return this.sessionCommand("attach", ref);
  }
  /** The same attach, read only: a key press never reaches the program. */
  viewCommand(ref: SessionRef) {
    return this.sessionCommand("view", ref);
  }
  private sessionCommand(mode: string, ref: SessionRef) {
    // The launcher attaches only the session with this identity, in one tmux command.
    if (!/^\d+:\$\d+:\d+$/.test(ref.identity))
      throw new Error("The session identity is invalid.");
    return [this.launcher, mode, sessionName(ref.name), ref.identity];
  }
  async shellCommand(ref: SessionRef, name: string) {
    const current = await this.resolve(ref.name, ref.identity);
    sessionName(name);
    if ((await this.sessions()).some((s) => s.name === name))
      throw new Error(
        "The shell name already exists. No session was attached.",
      );
    return {
      command: [this.launcher, "new", name, "--from", current.name],
      source: current,
    };
  }
  /** The command that signs in to AWS. It runs in a local view, because it needs a terminal. */
  loginCommand() {
    return [this.launcher, "login"];
  }
  async health() {
    return healthSample(JSON.parse(await this.call(["health"])));
  }
  /** Read the instance inventory for the spend estimate. The launcher makes read-only AWS calls. */
  async spend() {
    return spendReading(JSON.parse(await this.call(["spend"])));
  }
  /** Put a session in a project: a name path such as `studio/api`. Its directory stays. */
  async setProject(ref: SessionRef, project: string) {
    await this.resolve(ref.name, ref.identity);
    // An old project label is an absolute directory; the helper checks that it exists.
    const label = project.startsWith("/") ? project : projectName(project);
    return this.call(["project", ref.name, label]);
  }
  /** Start a session in a directory, or in a new folder in the workspaces folder. */
  async create(
    name: string,
    where: { dir: string } | { folder: string },
    project: string,
    subfolder?: string,
  ) {
    sessionName(name);
    // The workstation refuses a name that is taken, so no read of the list comes first.
    const place =
      "dir" in where ? ["--dir", where.dir] : ["--folder", where.folder];
    // An old project label is an absolute directory; the helper checks that it exists.
    const output = await this.call([
      "create",
      name,
      ...place,
      ...(subfolder ? ["--subfolder", subfolder] : []),
      "--project",
      project.startsWith("/") ? project : projectName(project),
    ]);
    // A current helper prints the identity of the new session; an older one prints only its name.
    return /^Created terminal: \S+ (\d+:\$\d+:\d+)$/m.exec(output)?.[1];
  }
  /** Move a project and the projects inside it, for example `api` to `studio/api`. */
  async moveProject(from: string, to: string) {
    return this.call(["move-project", from, projectName(to)]);
  }
  /** Rename a session; the helper renames only the session with this identity. */
  async renameSession(ref: SessionRef, to: string) {
    await this.resolve(ref.name, ref.identity);
    sessionName(to);
    if ((await this.sessions()).some((s) => s.name === to))
      throw new Error("A session with this name exists.");
    return this.call(["rename", ref.name, to, ref.identity]);
  }
  /** Forget a saved project without sessions, and the projects inside it. Its folders stay. */
  async forgetProject(path: string) {
    return this.call(["forget-project", projectName(path)]);
  }
  async end(ref: SessionRef, confirmation: string) {
    if (confirmation !== ref.name)
      throw new Error("Enter the exact session name.");
    await this.resolve(ref.name, ref.identity);
    return this.call(["--end-confirmed", ref.name, ref.identity]);
  }
}
