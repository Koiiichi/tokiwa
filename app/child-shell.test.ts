import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "./app";
import { BackendClient } from "./backend";

const pause = (ms = 20) => Bun.sleep(ms);

/**
 * A workspace whose snapshot holds claude-a ($1) with two child shells, a grandchild under the
 * newer one, and notes without a child. Each attached session gets a transport that stays open.
 */
async function workspace(width: number, height = 30) {
  const s = (name: string, id: number, created: number, parent = "") => ({
    name,
    project: "studio/api",
    cwd: `/w/${name}`,
    clients: 0,
    identity: `1:$${id}:${created}`,
    parent,
    activity: [],
  });
  const snapshot = {
    sessions: [
      s("claude-a", 1, 1),
      s("shell-old", 2, 5, "$1"),
      s("shell-new", 3, 9, "$1"),
      s("grand", 4, 12, "$3"),
      s("notes", 5, 2),
    ],
  };
  const backend = new BackendClient("/fixture/tokiwa", async () =>
    JSON.stringify(snapshot),
  );
  backend.attachCommand = () => ["/bin/sleep", "30"];
  const t = await createTestRenderer({ width, height });
  const app = new App(t.renderer, { backend, spawn: false });
  app.animate = false;
  await app.refreshSessions();
  app.focusSessions();
  await t.renderOnce();
  const settle = async () => {
    for (let i = 0; i < 100 && app.remotePending.size === 0; i++) await pause(5);
    for (let i = 0; i < 200 && app.remotePending.size; i++) await pause();
    await pause(50);
    await t.renderOnce();
  };
  /** Attach a session from the list with Enter, as the owner does. */
  const attach = async (name: string) => {
    app.focusSessions();
    app.listSelection = app.sessionRows().findIndex((r) => r.name === name);
    t.mockInput.pressEnter();
    await settle();
  };
  const dispose = async () => {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  };
  return { t, app, attach, dispose };
}

test("attaching a session opens its newest child shell beside it; the session keeps the keyboard", async () => {
  const w = await workspace(140);
  try {
    await w.attach("claude-a");
    expect(w.app.shells.map((s) => s.name)).toEqual(["claude-a", "shell-new"]);
    const [parent, child] = w.app.shells;
    expect(w.app.pair).toEqual([parent, child]);
    expect(w.app.shells[w.app.active]).toBe(parent);
    expect(parent.terminal.focused).toBe(true);
    expect(parent.pane.visible).toBe(true);
    expect(child.pane.visible).toBe(true);
    // The grandchild and the older child stay in the list.
    expect(w.app.shells.some((s) => s.name === "grand")).toBe(false);
    expect(w.app.shells.some((s) => s.name === "shell-old")).toBe(false);
  } finally {
    await w.dispose();
  }
});

test("a session without a child shell, a window too small for two views, or a child alone opens one view", async () => {
  const wide = await workspace(140);
  try {
    await wide.attach("notes");
    expect(wide.app.shells.map((s) => s.name)).toEqual(["notes"]);
    // Attaching a child does not open its parent or its own child.
    await wide.attach("shell-old");
    expect(wide.app.shells.map((s) => s.name)).toEqual(["notes", "shell-old"]);
  } finally {
    await wide.dispose();
  }
  const narrow = await workspace(60, 20);
  try {
    await narrow.attach("claude-a");
    expect(narrow.app.shells.map((s) => s.name)).toEqual(["claude-a"]);
  } finally {
    await narrow.dispose();
  }
});
