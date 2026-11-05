import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { EmbeddedTerminalRenderable } from "@opentui/core";
import { isTmuxStatus, themeRemoteStatus } from "./status-theme";

test("recognizes wide and truncated tmux footers, not ordinary output", () => {
  expect(isTmuxStatus('[worker0:bash*     "host" 19:46 31-Oct-26')).toBe(true);
  expect(isTmuxStatus('[worker<bas>"host" 19:46 31-Oct-26')).toBe(true);
  expect(isTmuxStatus("build succeeded")).toBe(false);
  expect(isTmuxStatus('"host" 19:46 31-Oct-26')).toBe(false);
});

test("remote footer paint changes colours without changing emulator text or body colours", async () => {
  const t = await createTestRenderer({ width: 60, height: 8 });
  const terminal = new EmbeddedTerminalRenderable(t.renderer, {
    id: "status-test",
    width: "100%",
    height: "100%",
    cols: 60,
    rows: 8,
  });
  t.renderer.root.add(terminal);
  try {
    await t.renderOnce();
    terminal.write(
      '\x1b[1;1H\x1b[30;42mGREEN_APPLICATION\x1b[0m\x1b[8;1H\x1b[30;42m[worker0:bash*   "host" 19:46 31-Oct-26\x1b[K\x1b[0m',
    );
    await t.renderOnce();
    const before = terminal.screen().text;
    const original = t.captureSpans();
    themeRemoteStatus(terminal, "#a4a7b1", "#0a0a0a");
    terminal.invalidate();
    await t.renderOnce();
    expect(terminal.screen().text).toBe(before);
    const after = t.captureSpans();
    expect(after.lines[0]).toEqual(original.lines[0]);
    expect(after.lines[7]).not.toEqual(original.lines[7]);
    expect(t.captureCharFrame()).toContain("[worker0:bash*");
    t.resize(48, 8);
    await t.renderOnce();
    terminal.write(
      '\x1b[8;1H\x1b[30;42m[worker<bas>"host" 19:46 31-Oct-26\x1b[K\x1b[0m',
    );
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("[worker<bas>");
  } finally {
    await t.dispose();
  }
});
