import { test, expect } from "bun:test";
import { BackendClient, LauncherError, splitCategory } from "./backend";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthHistory, activity } from "./state";
const ref = {
  name: "fixture-a",
  identity: "1:$2:3",
  cwd: "/work/a",
  project: "/work/a",
  clients: 0,
};
test("reconnect is attach-only and rejects missing or replaced identities", async () => {
  const commands: string[][] = [];
  let rows = [ref];
  const b = new BackendClient("/launcher", async (a) => {
    commands.push(a);
    return JSON.stringify({ sessions: rows });
  });
  // The launcher attaches only the session with this exact identity.
  expect(b.attachCommand(await b.resolve(ref.name, ref.identity))).toEqual([
    "/launcher",
    "attach",
    "fixture-a",
    ref.identity,
  ]);
  for (const identity of ["", "1:2:3", "1:$2:3' x", "1:$2:3\n"])
    expect(() => b.attachCommand({ ...ref, identity })).toThrow(
      "identity is invalid",
    );
  rows = [{ ...ref, identity: "1:$3:4" }];
  await expect(b.resolve(ref.name, ref.identity)).rejects.toThrow(
    "identity changed",
  );
  rows = [];
  await expect(b.resolve(ref.name, ref.identity)).rejects.toThrow(
    "No replacement",
  );
  expect(commands.every((a) => a[0] === "--snapshot")).toBe(true);
});
test("termination requires the exact name and a fresh matching identity", async () => {
  const commands: string[][] = [];
  const b = new BackendClient("/launcher", async (a) => {
    commands.push(a);
    return a[0] === "--snapshot"
      ? JSON.stringify({ sessions: [ref] })
      : "ended";
  });
  await expect(b.end(ref, "other")).rejects.toThrow();
  expect(commands).toEqual([]);
  await b.end(ref, ref.name);
  expect(commands.at(-1)).toEqual(["--end-confirmed", ref.name, ref.identity]);
});
test("projects: move, create, nest and forget delegate to the launcher with checked names", async () => {
  const commands: string[][] = [];
  const b = new BackendClient("/launcher", async (a) => {
    commands.push(a);
    return JSON.stringify({
      sessions: [ref],
      projects: { api: { dir: "/w/api" } },
    });
  });
  await b.setProject(ref, "studio/api");
  expect(commands.at(-1)).toEqual(["project", ref.name, "studio/api"]);
  await b.create("notes", { folder: "inbox" }, "inbox");
  expect(commands.at(-1)).toEqual([
    "create",
    "notes",
    "--folder",
    "inbox",
    "--project",
    "inbox",
  ]);
  await b.create("more", { dir: "/w/api" }, "api");
  expect(commands.at(-1)).toEqual([
    "create",
    "more",
    "--dir",
    "/w/api",
    "--project",
    "api",
  ]);
  // The workstation refuses a taken name, so create reads nothing first.
  const before = commands.length;
  await b.create("again", { dir: "/w/api" }, "api");
  expect(commands.length).toBe(before + 1);
  await b.moveProject("api", "studio/api");
  expect(commands.at(-1)).toEqual(["move-project", "api", "studio/api"]);
  await b.forgetProject("studio");
  expect(commands.at(-1)).toEqual(["forget-project", "studio"]);
  expect(b.projects).toEqual({ api: { dir: "/w/api" } });
  await expect(b.setProject(ref, "bad name")).rejects.toThrow("project name");
  await expect(b.create("bad name", { folder: "x" }, "x")).rejects.toThrow();
  // The identity that a current workstation prints, and none from an older one.
  const created = new BackendClient(
    "/fixture/tokiwa",
    async () => "Created terminal: notes 12:$4:1700\n",
  );
  expect(await created.create("notes", { folder: "inbox" }, "inbox")).toBe(
    "12:$4:1700",
  );
  const older = new BackendClient(
    "/fixture/tokiwa",
    async () => "Created terminal: notes\n",
  );
  expect(
    await older.create("notes", { folder: "inbox" }, "inbox"),
  ).toBeUndefined();
});
test("history preserves timestamps, errors, gaps and stale state", async () => {
  const h = new HealthHistory();
  let now = Date.now() / 1000;
  const sample = () => ({
    sampled_at: now,
    metrics: { cpu_percent: 1, ram_percent: 2 },
    rows: [],
    errors: [],
  });
  h.add(sample());
  expect(h.status(now)).toBe("live");
  expect(h.status(now + 66)).toBe("stale");
  await h.sample(async () => {
    throw new Error("offline");
  });
  expect(h.status()).toBe("partial");
  now += 1;
  await h.sample(async () => sample());
  expect((h.samples[1] as any).gap_before).toBe(true);
  expect(h.samples[1].sampled_at).toBe(now);
  expect(h.events[0].error).toContain("offline");
  expect(h.events[0].at).toBeGreaterThan(0);
  expect(() => h.add(sample())).toThrow("did not advance");
});
test("history samples without an attempt cap and keeps the last 120 readings", async () => {
  const h = new HealthHistory();
  const start = Date.now() / 1000 - 100;
  let calls = 0;
  for (let i = 0; i < 130; i++)
    await h.sample(async () => {
      calls++;
      if (i === 129) throw new Error("offline");
      return {
        sampled_at: start + i * 0.5,
        metrics: { cpu_percent: 1, ram_percent: 2 },
        rows: [],
        errors: [],
      };
    });
  expect(calls).toBe(130);
  expect(h.stopped).toBe(false);
  expect(h.samples).toHaveLength(120);
  expect(h.samples[0].sampled_at).toBe(start + 9 * 0.5);
  expect(h.events).toHaveLength(120);
  expect(h.events.at(-1)!.error).toContain("offline");
  expect(h.gap).toBe(true);
  h.stopped = true;
  await h.sample(async () => {
    calls++;
    throw new Error("closed");
  });
  expect(calls).toBe(130);
});
test("a recorded sample loads without the age check and reports recorded", () => {
  const h = new HealthHistory();
  h.load({
    sampled_at: 1000,
    metrics: { cpu_percent: 1, ram_percent: 2 },
    rows: [],
    errors: [],
  });
  expect(h.samples).toHaveLength(1);
  expect(h.recorded).toBe(true);
  expect(h.status(5000)).toBe("recorded");
  expect(() => h.load({ sampled_at: "x" })).toThrow("invalid");
});
test("spend delegates to the launcher and validates its inventory", async () => {
  const { fixtureSpend } = await import("./health-fixture");
  const commands: string[][] = [];
  let reply: unknown = fixtureSpend;
  const b = new BackendClient("/launcher", async (a) => {
    commands.push(a);
    return JSON.stringify(reply);
  });
  expect(await b.spend()).toEqual(fixtureSpend);
  expect(commands).toEqual([["spend"]]);
  reply = { ...fixtureSpend, volumes: "none" };
  await expect(b.spend()).rejects.toThrow("spend reading is invalid");
});
test("activity does not infer model intent", () => {
  expect(activity(true, false, 0)).toBe("disconnected");
  expect(activity(false, false, 0)).toBe("exited");
  expect(activity(true, true, 0)).toBe("unknown");
  expect(activity(true, true, Date.now(), true)).toBe("partial");
  expect(activity(true, true, Date.now())).toBe("output");
  expect(activity(true, true, 1)).toBe("quiet");
});
test("the snapshot bell is optional: an older host helper gives no bell", async () => {
  let rows: object[] = [ref];
  const b = new BackendClient("/launcher", async () =>
    JSON.stringify({ sessions: rows }),
  );
  expect((await b.sessions())[0].bell).toBe(false);
  rows = [{ ...ref, bell: true }];
  expect((await b.sessions())[0].bell).toBe(true);
  // A value that is not true is no bell; it does not stop session navigation.
  rows = [{ ...ref, bell: "yes" }];
  expect((await b.sessions())[0].bell).toBe(false);
});

test("the launcher starts in the home folder, not in the app's folder", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync, realpathSync } =
    await import("node:fs");
  const { tmpdir, homedir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = mkdtempSync(join(tmpdir(), "tokiwa-cwd-"));
  const launcher = join(folder, "tokiwa");
  writeFileSync(launcher, "#!/bin/sh\npwd -P\n");
  chmodSync(launcher, 0o755);
  try {
    // A reinstall replaces the app's folder under a running app, so its children must not start there.
    const where = (await new BackendClient(launcher).call(["x"])).trim();
    expect(where).toBe(realpathSync(homedir()));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

function stub(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tokiwa-stub-"));
  const path = join(dir, "tokiwa");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
const AUTH_TEXT =
  "Tokiwa: AWS authentication failed. Run aws sso login --profile profile-a.";
test("the launcher receives TOKIWA_ERROR_CATEGORY=1", async () => {
  const seen = join(mkdtempSync(join(tmpdir(), "tokiwa-seen-")), "seen");
  const path = stub(`printf %s "$TOKIWA_ERROR_CATEGORY" > ${seen}\necho '{}'`);
  await new BackendClient(path).call(["health"]);
  expect(readFileSync(seen, "utf8")).toBe("1");
});
test("a category line becomes a field and leaves the message", async () => {
  const path = stub(
    `echo '${AUTH_TEXT}' >&2\necho 'tokiwa-error: auth' >&2\nexit 1`,
  );
  const err = await new BackendClient(path).call(["health"]).catch((e) => e);
  expect(err).toBeInstanceOf(LauncherError);
  expect(err.category).toBe("auth");
  expect(err.code).toBe(1);
  expect(err.reason).toBe("exit");
  expect(err.command).toBe("health");
  expect(err.message).toBe(`Launcher health exited 1: ${AUTH_TEXT}`);
  expect(err.message).not.toContain("tokiwa-error");
  expect(err.stderr).not.toContain("tokiwa-error");
});
test("an unknown category is ignored", async () => {
  const path = stub(`echo 'bad' >&2\necho 'tokiwa-error: other' >&2\nexit 1`);
  const err = await new BackendClient(path).call(["health"]).catch((e) => e);
  expect(err).toBeInstanceOf(LauncherError);
  expect(err.category).toBeUndefined();
  expect(err.stderr).toContain("tokiwa-error: other");
});
test("splitCategory removes only a final known category line", () => {
  expect(splitCategory("a\ntokiwa-error: unreachable\n")).toEqual({
    text: "a",
    category: "unreachable",
  });
  expect(splitCategory("tokiwa-error: auth\nb")).toEqual({
    text: "tokiwa-error: auth\nb",
  });
});
test("a timeout and a missing launcher are typed", async () => {
  // The test guard allows only a launcher inside the temporary folder, so use a file that cannot run.
  const unrunnable = stub("exit 0");
  chmodSync(unrunnable, 0o644);
  const missing = await new BackendClient(unrunnable)
    .call(["health"])
    .catch((e) => e);
  expect(missing).toBeInstanceOf(LauncherError);
  expect(missing.reason).toBe("spawn");
  expect(missing.code).toBeNull();
  const slow = stub("exec sleep 5");
  const timed = await new BackendClient(slow, undefined, 100)
    .call(["health"])
    .catch((e) => e);
  expect(timed).toBeInstanceOf(LauncherError);
  expect(timed.reason).toBe("timeout");
  expect(timed.message).toBe("The launcher exceeded 90 seconds.");
});
