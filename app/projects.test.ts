import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "./app";
import { BackendClient } from "./backend";

/** A fake launcher: a snapshot with nested projects and a child shell, and every call recorded. */
async function projects(options: { probe?: () => Promise<number> } = {}) {
  const s = (name: string, project: string, id: number, parent = "") => ({
    name,
    project,
    cwd: `/w/${name}`,
    clients: 0,
    identity: `1:$${id}:1`,
    parent,
    activity: [],
  });
  const calls: string[][] = [];
  const snapshot = {
    sessions: [
      s("claude-a", "studio/api", 1),
      s("shell-1", "studio/api", 2, "$1"),
      s("notes", "inbox", 3),
    ],
    projects: {
      "studio/api": { dir: "/w/api" },
      archive: { dir: "/w/archive" },
    },
  };
  const backend = new BackendClient("/fixture/tokiwa", async (args) => {
    calls.push(args);
    return args[0] === "--snapshot" ? JSON.stringify(snapshot) : "ok";
  });
  const t = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(t.renderer, {
    spawn: false,
    backend,
    healthConfig: "/nonexistent/health.json",
    ...options,
  });
  app.animate = false;
  app.attachRemote = async () => {};
  await app.refreshSessions();
  app.focusSessions();
  await t.renderOnce();
  const lines = () => t.captureCharFrame().split("\n");
  const at = (label: string) => {
    const y = lines().findIndex((l) => l.includes(label));
    return { x: lines()[y].indexOf(label), y };
  };
  const type = async (text: string) => {
    await t.mockInput.typeText(text);
    t.mockInput.pressEnter();
    for (let i = 0; i < 50 && app.confirm; i++) await Bun.sleep(10);
    // The operation reads the sessions again and redraws the list; let that land.
    await Bun.sleep(30);
    await t.renderOnce();
  };
  return {
    t,
    app,
    calls,
    at,
    lines,
    type,
    launched: () => calls.filter((c) => c[0] !== "--snapshot"),
  };
}

test("the list nests projects and child shells, and keeps an empty saved project", async () => {
  const p = await projects();
  try {
    const list = p.lines().map((l) => l.slice(0, 34).trimEnd());
    const shown = list.slice(list.findIndex((l) => l.includes("archive")));
    expect(shown.slice(0, 9)).toEqual([
      "  archive",
      "",
      "  inbox",
      "  ›   notes",
      "",
      "  studio",
      "    api",
      "        claude-a",
      "      └   shell-1",
    ]);
  } finally {
    await p.t.dispose();
  }
});

test("+ on a project title starts a named session in its folder; + new project at the end of the list makes a project", async () => {
  const p = await projects();
  try {
    const api = p.at("api");
    await p.t.mockMouse.moveTo(api.x, api.y);
    await p.t.renderOnce();
    const plus = p.lines()[api.y].lastIndexOf("+");
    expect(plus).toBeGreaterThan(api.x);
    await p.t.mockMouse.click(plus, api.y);
    expect(p.app.confirm?.operation).toBe("new-session");
    await p.type("review");
    expect(p.launched().at(-1)).toEqual([
      "create",
      "review",
      "--dir",
      "/w/api",
      "--subfolder",
      "review",
      "--project",
      "studio/api",
    ]);
    // An empty name takes the suggested one.
    p.app.askOperation({
      operation: "new-session",
      path: "inbox",
      dir: "/w/notes",
    });
    await p.type("");
    expect(p.launched().at(-1)).toEqual([
      "create",
      "inbox",
      "--dir",
      "/w/notes",
      "--subfolder",
      "inbox",
      "--project",
      "inbox",
    ]);
    const add = p.at("+ new project");
    await p.t.mockMouse.click(add.x + 2, add.y);
    expect(p.app.confirm?.operation).toBe("new-project");
    await p.type("studio/inbox");
    expect(p.launched().at(-1)).toEqual([
      "create",
      "inbox",
      "--folder",
      "inbox",
      "--subfolder",
      "inbox",
      "--project",
      "studio/inbox",
    ]);
    // A project with an old directory label takes a new session too, in that directory.
    const old = "/srv/state/workspaces/workbench";
    p.app.askOperation({ operation: "new-session", path: old, dir: old });
    await p.type("tools2");
    expect(p.launched().at(-1)).toEqual([
      "create",
      "tools2",
      "--dir",
      old,
      "--subfolder",
      "tools2",
      "--project",
      old,
    ]);
    // Ending a project names its sessions and asks with one key.
    p.app.askEndProject("studio");
    await p.t.renderOnce();
    expect(p.lines().join("\n")).toContain("enter ends · esc keeps");
    p.t.mockInput.pressEscape();
    await Bun.sleep(40);
    expect(p.app.endingProject).toBeUndefined();
    // A project without sessions is only forgotten.
    p.app.askEndProject("empty");
    expect(p.app.endingProjectSpans()[0].text).toContain(
      "forget this project?",
    );
    p.t.mockInput.pressEscape();
    await Bun.sleep(40);
    expect(p.app.endingProject).toBeUndefined();
  } finally {
    await p.t.dispose();
  }
});

test("ending a project asks with one key and ends its sessions; a session asks in its row and can keep its shells", async () => {
  const p = await projects();
  try {
    const studio = p.at("studio");
    await p.t.mockMouse.moveTo(studio.x, studio.y);
    await p.t.renderOnce();
    await p.t.mockMouse.click(p.lines()[studio.y].lastIndexOf("×"), studio.y);
    await p.t.renderOnce();
    expect(p.lines().join("\n")).toContain("end claude-a, shell-1?");
    const asked = p.launched().length;
    p.t.mockInput.pressEscape();
    await Bun.sleep(40);
    expect(p.app.endingProject).toBeUndefined();
    expect(p.launched().length).toBe(asked);
    p.app.askEndProject("studio");
    p.t.mockInput.pressEnter();
    for (let i = 0; i < 50 && p.app.endingProject; i++) await Bun.sleep(10);
    expect(p.launched().slice(-3)).toEqual([
      ["--end-confirmed", "claude-a", "1:$1:1"],
      ["--end-confirmed", "shell-1", "1:$2:1"],
      ["forget-project", "studio"],
    ]);
    // Ending a session asks in its row; enter ends it with the shells opened from it.
    const claude = p.app.remoteSessions.find((r) => r.name === "claude-a")!;
    p.app.askEnd(claude);
    await p.t.renderOnce();
    expect(p.lines().join("\n")).toContain("end claude-a and 1 shell?");
    p.t.mockInput.pressEnter();
    for (let i = 0; i < 50 && p.app.ending; i++) await Bun.sleep(10);
    expect(p.launched().slice(-2)).toEqual([
      ["--end-confirmed", "claude-a", "1:$1:1"],
      ["--end-confirmed", "shell-1", "1:$2:1"],
    ]);
    // s ends only the session and keeps its shells; esc keeps both.
    p.app.askEnd(claude);
    p.t.mockInput.pressKey("s");
    for (let i = 0; i < 50 && p.app.ending; i++) await Bun.sleep(10);
    expect(p.launched().at(-1)).toEqual([
      "--end-confirmed",
      "claude-a",
      "1:$1:1",
    ]);
    const before = p.launched().length;
    p.app.askEnd(claude);
    p.t.mockInput.pressEscape();
    await Bun.sleep(80);
    expect(p.app.ending).toBeUndefined();
    expect(p.launched().length).toBe(before);
    // Any other key means the question was not meant: it goes away and ends nothing.
    p.app.askEnd(claude);
    p.t.mockInput.pressKey("a");
    expect(p.app.ending).toBeUndefined();
    p.t.mockInput.pressEnter();
    await Bun.sleep(30);
    expect(p.launched().length).toBe(before);
    // Under the pointer a session row shows ×, which asks the same question.
    const notes = p.at("notes");
    await p.t.mockMouse.moveTo(notes.x, notes.y);
    await p.t.renderOnce();
    const close = p.lines()[notes.y].lastIndexOf("×");
    expect(close).toBeGreaterThan(notes.x);
    await p.t.mockMouse.click(close, notes.y);
    expect(p.app.ending?.ref.name).toBe("notes");
  } finally {
    await p.t.dispose();
  }
});

test("a project title dropped between projects reorders them; a double click renames", async () => {
  const p = await projects();
  try {
    const top = () =>
      p.app
        .sessionTree()
        .filter((e) => e.kind === "project" && e.depth === 0)
        .map((e) => (e.kind === "project" ? e.path : ""));
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 100 && !done(); i++) {
        await Bun.sleep(10);
        await p.t.renderOnce();
      }
      // The drop also reads the sessions again and redraws the list; let that land.
      await Bun.sleep(30);
      await p.t.renderOnce();
    };
    expect(top()).toEqual(["archive", "inbox", "studio"]);
    // The blank line above inbox is the place before it.
    const studio = p.at("studio");
    const inbox = p.at("inbox");
    await p.t.mockMouse.drag(studio.x + 1, studio.y, 2, inbox.y - 1);
    await until(() => top()[1] === "studio");
    expect(top()).toEqual(["archive", "studio", "inbox"]);
    // Dropped on Workspace, a project goes first.
    const k = p.at("inbox");
    const nav = p.at("Workspace  Health");
    await p.t.mockMouse.drag(k.x + 1, k.y, nav.x + 1, nav.y);
    await until(() => top()[0] === "inbox");
    expect(top()).toEqual(["inbox", "archive", "studio"]);
    // A double click on a title asks for the new name, filled with the current one.
    const title = p.at("studio");
    await p.t.mockMouse.click(title.x + 1, title.y);
    await p.t.mockMouse.click(title.x + 1, title.y);
    expect(p.app.confirm?.operation).toBe("rename-project");
    expect(p.app.search!.value).toBe("studio");
    p.app.search!.value = "";
    await p.type("studio2");
    expect(p.launched().at(-1)).toEqual(["move-project", "studio", "studio2"]);
  } finally {
    await p.t.dispose();
  }
});

test("the status shows the link as a dot, and under the pointer opens a card with the Mac, ping and loss", async () => {
  const times = [40, 50, null];
  const p = await projects({
    probe: async () => {
      const ms = times.shift();
      if (ms == null) throw new Error("timeout");
      return ms;
    },
  });
  try {
    const status = p.at("● EC2");
    await p.t.mockMouse.moveTo(status.x + 2, status.y);
    await p.t.renderOnce();
    let card = p.lines().join("\n");
    expect(card).toContain("Connection");
    expect(card).toContain(`${p.app.device} → EC2 · connected`);
    expect(card).toMatch(/ping +measuring…/);
    expect(card).toContain("0 open here · 3 on the workstation");
    await p.app.probe();
    await p.app.probe();
    await p.t.renderOnce();
    card = p.lines().join("\n");
    expect(card).toMatch(/ping +50 ms {2}avg 45 ms · jitter 10 ms/);
    expect(card).toMatch(/loss +0 % \(0 of the last 2 tries\)/);
    await p.app.probe();
    await p.t.renderOnce();
    card = p.lines().join("\n");
    expect(card).toMatch(/ping +lost · avg 45 ms/);
    expect(card).toMatch(/loss +33 % \(1 of the last 3 tries\)/);
    expect(card).not.toContain("last read");
    await p.t.mockMouse.moveTo(2, 20);
    await p.t.renderOnce();
    expect(p.lines().join("\n")).not.toContain("jitter");
  } finally {
    await p.t.dispose();
  }
});

test("a double click on a session row asks for its new name and renames only that session", async () => {
  const p = await projects();
  try {
    const notes = p.at("notes");
    await p.t.mockMouse.click(notes.x + 1, notes.y);
    await p.t.mockMouse.click(notes.x + 1, notes.y);
    expect(p.app.confirm?.operation).toBe("rename-session");
    expect(p.app.search!.value).toBe("notes");
    p.app.search!.value = "";
    await p.type("inbox-notes");
    expect(p.launched().at(-1)).toEqual([
      "rename",
      "notes",
      "inbox-notes",
      "1:$3:1",
    ]);
  } finally {
    await p.t.dispose();
  }
});

test("the connection probe keeps its interval after the startup glyph settles", async () => {
  const p = await projects();
  try {
    let ticks = 0;
    p.app.probeTimer = setInterval(() => ticks++, 10);
    p.app.startupTimer = setInterval(() => {}, 1000);
    // The first host read has ended, so the header glyph settles and its timer stops.
    p.app.drawLocation();
    expect(p.app.startupTimer).toBeUndefined();
    const before = ticks;
    await Bun.sleep(60);
    expect(ticks).toBeGreaterThan(before);
  } finally {
    clearInterval(p.app.probeTimer);
    await p.t.dispose();
  }
});
