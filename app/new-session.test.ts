import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "./app";
import { BackendClient, type SessionRef } from "./backend";

const session = (
  name: string,
  project: string,
  id: number,
  command = "node",
): SessionRef => ({
  name,
  project,
  cwd: `/w/${name}`,
  clients: 0,
  identity: `1:$${id}:1`,
  parent: "",
  managed: true,
  activity: [{ pane: `%${id}`, dead: false, command, screen: "a" }],
});

/** A create call that the test answers when it chooses. */
function pending() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** A fake launcher whose create waits for the test, and an attach that records its target. */
async function workspace(create = pending()) {
  const calls: string[][] = [];
  const sessions = [session("notes", "inbox", 3)];
  // While set, a read of the list waits for it, as a slow read on the workstation does.
  let hold: Promise<string> | undefined;
  const backend = new BackendClient("/fixture/tokiwa", async (args) => {
    calls.push(args);
    if (args[0] === "--snapshot" && hold) await hold;
    if (args[0] === "--snapshot")
      return JSON.stringify({
        sessions,
        projects: { inbox: { dir: "/w/inbox" } },
      });
    if (args[0] === "create") return create.promise;
    return "ok";
  });
  const t = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(t.renderer, {
    spawn: false,
    backend,
    healthConfig: "/nonexistent/health.json",
  });
  app.animate = false;
  const attached: { name: string; identity?: string; known: boolean }[] = [];
  app.attachRemote = async (name, expected, _reconnect, _child, known) => {
    attached.push({
      name,
      identity: known?.identity ?? expected,
      known: !!known,
    });
  };
  await app.refreshSessions();
  app.focusSessions();
  await t.renderOnce();
  const settle = async () => {
    await Bun.sleep(40);
    await t.renderOnce();
  };
  /** Ask for a new session in inbox and answer with `name`. */
  const start = async (name: string) => {
    app.askOperation({
      operation: "new-session",
      path: "inbox",
      dir: "/w/inbox",
    });
    await t.mockInput.typeText(name);
    t.mockInput.pressEnter();
    await settle();
  };
  // Only the list column: the pane beside it has text of its own.
  const row = (name: string) =>
    t
      .captureCharFrame()
      .split("\n")
      .map((line) => line.slice(0, 36))
      .find((line) => new RegExp(`[◆◇◈○·]? ${name}\\b`).test(line)) ?? "";
  return {
    t,
    app,
    calls,
    sessions,
    attached,
    create,
    settle,
    start,
    row,
    frame: () => t.captureCharFrame(),
    hold: (until: Promise<string> | undefined) => (hold = until),
    reads: () => calls.filter((c) => c[0] === "--snapshot").length,
    dispose: () => t.dispose(),
  };
}

test("the new session prompt names its project above the input, so the default name shows", async () => {
  const w = await workspace();
  try {
    w.app.askOperation({
      operation: "new-session",
      path: "studio-review-board",
      dir: "/w/inbox",
    });
    await w.t.renderOnce();
    const frame = w.frame();
    expect(frame).toContain("New session in studio-review-board");
    expect(frame).toContain("name, or enter for studio-review-board");
  } finally {
    w.dispose();
  }
});

test("enter closes the prompt at once, and the row says starting", async () => {
  const w = await workspace();
  try {
    const before = w.reads();
    await w.start("fresh");
    expect(w.app.palette).toBeUndefined();
    expect(w.row("fresh")).toContain("starting");
    expect(w.calls.filter((c) => c[0] === "create")).toHaveLength(1);
    // The workstation refuses a taken name, so no read comes before the create.
    expect(w.reads()).toBe(before);
  } finally {
    w.dispose();
  }
});

test("the identity from the workstation attaches the new session without another read", async () => {
  const w = await workspace();
  try {
    await w.start("fresh");
    const before = w.reads();
    let readsAtAttach = -1;
    const record = w.app.attachRemote;
    w.app.attachRemote = async (...args) => {
      readsAtAttach = w.reads();
      return record(...args);
    };
    w.create.resolve("Created terminal: fresh 1:$9:1\n");
    await w.settle();
    expect(w.attached).toEqual([
      { name: "fresh", identity: "1:$9:1", known: true },
    ]);
    expect(readsAtAttach).toBe(before);
    expect(w.row("fresh")).not.toContain("starting");
  } finally {
    w.dispose();
  }
});

test("a read that began before the session existed keeps its row", async () => {
  const w = await workspace();
  try {
    await w.start("fresh");
    const slow = pending();
    w.hold(slow.promise);
    const read = w.app.refreshSessions();
    w.create.resolve("Created terminal: fresh 1:$9:1\n");
    await w.settle();
    slow.resolve("");
    await read;
    w.hold(undefined);
    await w.settle();
    expect(w.row("fresh")).toContain("fresh");
    // A read that begins after the creation is the truth again.
    await w.app.refreshSessions();
    await w.settle();
    expect(w.row("fresh")).toBe("");
  } finally {
    w.dispose();
  }
});

test("a workstation that prints no identity: the app reads the list, then attaches", async () => {
  const w = await workspace();
  try {
    await w.start("fresh");
    w.sessions.push(session("fresh", "inbox", 9));
    w.create.resolve("Created terminal: fresh\n");
    await w.settle();
    expect(w.attached).toEqual([
      { name: "fresh", identity: "1:$9:1", known: false },
    ]);
  } finally {
    w.dispose();
  }
});

test("a key pressed while the session starts keeps the pane, and the footer says it is ready", async () => {
  const w = await workspace();
  try {
    await w.start("fresh");
    w.t.mockInput.pressArrow("down");
    await w.settle();
    w.create.resolve("Created terminal: fresh 1:$9:1\n");
    await w.settle();
    expect(w.attached).toEqual([]);
    expect(w.frame()).toContain("fresh is ready");
  } finally {
    w.dispose();
  }
});

test("a failed start removes the row and says why", async () => {
  const w = await workspace();
  try {
    await w.start("fresh");
    w.create.reject(new Error("This session exists. Use tokiwa attach NAME."));
    await w.settle();
    expect(w.row("fresh")).toBe("");
    expect(w.frame()).toContain("This session exists");
    expect(w.attached).toEqual([]);
  } finally {
    w.dispose();
  }
});

test("a taken or invalid name stays in the prompt and calls nothing", async () => {
  const w = await workspace();
  try {
    await w.start("notes");
    expect(w.app.palette).toBeDefined();
    expect(w.frame()).toContain("A session with this name exists.");
    w.t.mockInput.pressEscape();
    await w.settle();
    await w.start("bad name");
    expect(w.app.palette).toBeDefined();
    expect(w.calls.filter((c) => c[0] === "create")).toEqual([]);
  } finally {
    w.dispose();
  }
});

test("a session that runs only a shell says shell; one that runs an agent does not", async () => {
  const w = await workspace();
  try {
    w.sessions.push(session("plain", "inbox", 7, "bash"));
    w.sessions.push(session("agent", "inbox", 8, "claude"));
    await w.app.refreshSessions();
    await w.t.renderOnce();
    expect(w.row("plain")).toContain("shell");
    expect(w.row("agent")).not.toContain("shell");
  } finally {
    w.dispose();
  }
});

test("a new session gets its own folder; tab starts it in the project folder", async () => {
  const w = await workspace();
  try {
    w.app.askOperation({
      operation: "new-session",
      path: "inbox",
      dir: "/w/inbox",
    });
    await w.t.mockInput.typeText("fresh");
    await w.settle();
    expect(w.frame()).toContain("It starts in inbox/fresh");
    expect(w.frame()).toContain("tab project folder");
    w.t.mockInput.pressEnter();
    await w.settle();
    expect(w.calls.find((c) => c[0] === "create")).toEqual([
      "create",
      "fresh",
      "--dir",
      "/w/inbox",
      "--subfolder",
      "fresh",
      "--project",
      "inbox",
    ]);
    w.app.askOperation({
      operation: "new-session",
      path: "inbox",
      dir: "/w/inbox",
    });
    await w.t.mockInput.typeText("shared");
    w.t.mockInput.pressTab();
    await w.settle();
    expect(w.frame()).toContain("It starts in w/inbox");
    expect(w.frame()).toContain("tab own folder");
    w.t.mockInput.pressEnter();
    await w.settle();
    expect(w.calls.filter((c) => c[0] === "create").at(-1)).toEqual([
      "create",
      "shared",
      "--dir",
      "/w/inbox",
      "--project",
      "inbox",
    ]);
  } finally {
    w.dispose();
  }
});

test("the first session of a new project gets its own folder too", async () => {
  const w = await workspace();
  try {
    w.app.askOperation({ operation: "new-project" });
    await w.t.mockInput.typeText("studio/review");
    w.t.mockInput.pressEnter();
    await w.settle();
    expect(w.calls.find((c) => c[0] === "create")).toEqual([
      "create",
      "review",
      "--folder",
      "review",
      "--subfolder",
      "review",
      "--project",
      "studio/review",
    ]);
  } finally {
    w.dispose();
  }
});

test("a frozen session says frozen, also when it runs only a shell", async () => {
  const w = await workspace();
  try {
    w.sessions.push({ ...session("held", "inbox", 7, "bash"), frozen: true });
    await w.app.refreshSessions();
    await w.t.renderOnce();
    expect(w.row("held")).toContain("frozen");
    expect(w.row("held")).not.toContain("shell");
  } finally {
    w.dispose();
  }
});

test("each row shows its agent's state, and a waiting agent needs you", async () => {
  const w = await workspace();
  const with_ = (name: string, id: number, state: string): SessionRef => ({
    ...session(name, "inbox", id, "claude"),
    agent: { state, at: 1 },
  });
  try {
    w.sessions.push(
      with_("busy", 11, "working"),
      with_("asking", 12, "waiting"),
      with_("done", 13, "idle"),
      with_("capped", 14, "limited"),
      { ...with_("held", 15, "working"), frozen: true },
    );
    await w.app.refreshSessions();
    await w.t.renderOnce();
    expect(w.row("busy")).toContain("working");
    expect(w.row("asking")).toMatch(/◈ asking +waiting/);
    expect(w.row("done")).toContain("idle");
    expect(w.row("capped")).toContain("limited");
    // A frozen agent's last state is stale, so frozen shows.
    expect(w.row("held")).toContain("frozen");
    const row = (name: string) =>
      w.app.sessionRows().find((r) => r.name === name)!;
    expect(w.app.needsYou(row("asking"))).toBe(true);
    expect(w.app.needsYou(row("busy"))).toBe(false);
  } finally {
    w.dispose();
  }
});
