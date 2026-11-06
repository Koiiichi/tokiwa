import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "./app";
import { steadyCursor } from "./cursor";

const SETTLE = 30;
const pause = (ms: number) => Bun.sleep(ms);

function fake() {
  const placed: [number, number, boolean][] = [];
  let renders = 0;
  const renderer = {
    isDestroyed: false,
    setCursorPosition(x: number, y: number, visible = true) {
      placed.push([x, y, visible]);
    },
    requestRender() {
      renders++;
    },
  };
  steadyCursor(renderer, SETTLE);
  return { renderer, placed, renders: () => renders };
}

test("rows that a redraw passes through never show the cursor", () => {
  const { renderer, placed } = fake();
  renderer.setCursorPosition(3, 29, true);
  for (const row of [2, 7, 11, 18, 26])
    renderer.setCursorPosition(1, row, true);
  renderer.setCursorPosition(3, 29, true);
  expect(placed.every(([, y, visible]) => y === 29 && visible)).toBe(true);
});

test("typing on one row moves the cursor at once", () => {
  const { renderer, placed } = fake();
  renderer.setCursorPosition(3, 10, true);
  renderer.setCursorPosition(4, 10, true);
  expect(placed.at(-1)).toEqual([4, 10, true]);
});

test("a new row that holds still takes the cursor, with a repaint", async () => {
  const { renderer, placed, renders } = fake();
  renderer.setCursorPosition(3, 10, true);
  renderer.setCursorPosition(1, 11, true);
  expect(placed.at(-1)).toEqual([3, 10, true]);
  await pause(SETTLE * 2);
  expect(placed.at(-1)).toEqual([1, 11, true]);
  expect(renders()).toBe(1);
  renderer.setCursorPosition(2, 11, true);
  expect(placed.at(-1)).toEqual([2, 11, true]);
});

test("a row that keeps changing never settles", async () => {
  const { renderer, placed } = fake();
  renderer.setCursorPosition(3, 29, true);
  for (let row = 1; row < 8; row++) {
    renderer.setCursorPosition(1, row, true);
    await pause(SETTLE / 3);
  }
  renderer.setCursorPosition(3, 29, true);
  await pause(SETTLE * 2);
  expect(placed.every(([, y]) => y === 29)).toBe(true);
});

test("a hidden cursor stays hidden", () => {
  const { renderer, placed } = fake();
  renderer.setCursorPosition(3, 10, true);
  renderer.setCursorPosition(0, 0, false);
  expect(placed.at(-1)).toEqual([0, 0, false]);
});

test("a hidden cursor cancels a row that was waiting", async () => {
  const { renderer, placed } = fake();
  renderer.setCursorPosition(3, 10, true);
  renderer.setCursorPosition(1, 11, true);
  renderer.setCursorPosition(0, 0, false);
  await pause(SETTLE * 2);
  expect(placed.at(-1)).toEqual([0, 0, false]);
});

test("a destroyed renderer gets no late cursor", async () => {
  const { renderer, placed } = fake();
  renderer.setCursorPosition(3, 10, true);
  renderer.setCursorPosition(1, 11, true);
  const count = placed.length;
  renderer.isDestroyed = true;
  await pause(SETTLE * 2);
  expect(placed).toHaveLength(count);
});

test("the app holds the cursor of a terminal view through a redraw", async () => {
  const t = await createTestRenderer({ width: 100, height: 30 });
  const seen: [number, boolean][] = [];
  const place = t.renderer.setCursorPosition.bind(t.renderer);
  t.renderer.setCursorPosition = (x, y, visible = true) => {
    seen.push([y, visible]);
    place(x, y, visible);
  };
  const app = new App(t.renderer, { spawn: false });
  const shell = app.startShell("view", false, "/tmp", [
    "/bin/sh",
    "-c",
    "exec cat",
  ])!;
  try {
    app.active = 0;
    app.show("shell");
    shell.terminal.focus();
    shell.terminal.write("\x1b[20;3H");
    await pause(120);
    await t.renderOnce();
    await t.renderOnce();
    seen.length = 0;
    for (const row of [2, 6, 11, 15]) {
      shell.terminal.write(`\x1b[${row};1Hredraw`);
      await pause(10);
      await t.renderOnce();
    }
    const rows = seen.filter(([, visible]) => visible).map(([y]) => y);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows).size).toBe(1);
  } finally {
    const child = shell.child.exited;
    await t.dispose();
    await child;
  }
});
