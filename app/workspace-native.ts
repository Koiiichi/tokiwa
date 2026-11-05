/** Model-free native evidence harness. Attach only to the named disposable shell. */
import { createCliRenderer } from "@opentui/core";
import { writeFileSync } from "node:fs";
import { App } from "./app";
const [name, output, companion] = process.argv.slice(2);
if (!name?.startsWith("opentui-workspace-") || !output)
  throw new Error(
    "Supply a disposable workspace session and an evidence path.",
  );
const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  targetFps: 30,
});
const title = `Tokiwa workspace proof ${process.pid}`;
process.stdout.write(`\x1b]2;${title}\x07`);
const app = new App(renderer, {
  spawn: false,
  layout: "workspace",
  receipt: output + ".events.json",
});
await app.attachRemote(name);
if (companion) {
  await app.attachRemote(companion);
  if (app.shells.length === 2) {
    app.pair = [app.shells[0], app.shells[1]];
    app.show("shell");
  }
}
const timer = setInterval(
  () =>
    writeFileSync(
      output + ".state.json",
      JSON.stringify({
        appPid: process.pid,
        title,
        width: renderer.width,
        height: renderer.height,
        active: app.shells[app.active]?.name,
        error: app.error,
        view: app.view,
        explorer: !!app.explorer,
        fileBusy: app.fileBusy,
        fileError: app.fileError,
        fileTarget: app.fileTarget,
        fileData: app.fileData,
        shells: app.shells.map((s) => ({
          name: s.name,
          remote: s.remote,
          pid: s.child.pid,
          exited: s.exited,
          screen: s.terminal.screen().text,
          columns: s.terminal.screen().columns,
          rows: s.terminal.screen().rows,
          focused: s.terminal.focused,
          visible: s.pane.visible,
          x: s.terminal.x,
          y: s.terminal.y,
        })),
      }),
    ),
  150,
);
const timeout = setTimeout(() => app.close(), 20 * 60 * 1000);
renderer.on("destroy", () => {
  clearInterval(timer);
  clearTimeout(timeout);
});
