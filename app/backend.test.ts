import { test, expect } from "bun:test";
import { BackendClient } from "./backend";
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
  await b.moveProject("api", "studio/api");
  expect(commands.at(-1)).toEqual(["move-project", "api", "studio/api"]);
  await b.forgetProject("studio");
  expect(commands.at(-1)).toEqual(["forget-project", "studio"]);
  expect(b.projects).toEqual({ api: { dir: "/w/api" } });
  await expect(b.setProject(ref, "bad name")).rejects.toThrow("project name");
  await expect(b.create(ref.name, { folder: "x" }, "x")).rejects.toThrow(
    "exists",
  );
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
