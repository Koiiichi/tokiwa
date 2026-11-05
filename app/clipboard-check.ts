/** Native Ghostty clipboard fixture. It starts no shell or remote session. */
import { createCliRenderer, EmbeddedTerminalRenderable } from "@opentui/core";
import { App } from "./app";
import { writeFileSync } from "node:fs";
const path = process.argv[2];
if (!path) throw new Error("Supply the result path.");
const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  targetFps: 30,
});
const app = new App(renderer, {
  spawn: false,
  layout: "terminal",
  receipt: path + ".events.json",
});
const terminal = new EmbeddedTerminalRenderable(renderer, {
  id: "copy-native",
  width: "100%",
  // A fixed height keeps the fixture text visible in every pane layout.
  height: 8,
});
app.shellPane.add(terminal);
app.show("shell");
terminal.focus();
terminal.write("SELECT_NATIVE 日本語\r\n");
const input: number[] = [];
// Keep the last SGR mouse reports so that a native driver can calibrate its pointer position.
const mouse: string[] = [];
process.stdin.on("data", (data) => {
  const text = Buffer.from(data).toString("latin1");
  for (const report of text.match(/\x1b\[<\d+;\d+;\d+[Mm]/g) ?? [])
    mouse.push(report.slice(1));
  mouse.splice(0, Math.max(0, mouse.length - 40));
});
terminal.onData = (bytes) => input.push(...bytes);
const timer = setInterval(
  () =>
    writeFileSync(
      path,
      JSON.stringify({
        pid: process.pid,
        x: terminal.x,
        y: terminal.y,
        width: terminal.width,
        height: terminal.height,
        resolution: renderer.resolution,
        columns: renderer.width,
        rows: renderer.height,
        selected: renderer.getSelection()?.getSelectedText() ?? "",
        input,
        mouse,
        lines: terminal.screen().lines.slice(0, 4),
      }),
    ),
  100,
);
const deadline = setTimeout(() => app.close(), 180000);
renderer.on("destroy", () => {
  clearInterval(timer);
  clearTimeout(deadline);
});
