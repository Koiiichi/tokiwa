/** Native disposable-shell comparison. No model or session creation occurs here. */
import { createCliRenderer } from "@opentui/core";
import { appendFileSync, writeFileSync } from "node:fs";
import { App } from "./app";
const [name, relay, trace, receipt] = process.argv.slice(2);
if (!name?.startsWith("opentui-input-"))
  throw new Error("Use a disposable input fixture.");
const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  targetFps: 30,
});
const record = (direction: string, data: Uint8Array | string) =>
  appendFileSync(
    trace,
    JSON.stringify({
      t: performance.now() / 1000,
      direction,
      hex: Buffer.from(data).toString("hex"),
    }) + "\n",
  );
process.stdin.on("data", (data) => record("outer-input", data));
renderer.keyInput.on("keypress", (key) =>
  record(
    "key",
    JSON.stringify({
      name: key.name,
      ctrl: key.ctrl,
      shift: key.shift,
      sequence: key.sequence,
    }),
  ),
);
process.stdout.write(`\x1b]2;Tokiwa input proof ${process.pid}\x07`);
const app = new App(renderer, {
  spawn: false,
  receipt,
  layout: "terminal",
});
if (relay === "local") {
  app.backend.resolve = async (n) => {
    await Bun.sleep(1000);
    return {
      name: n,
      identity: "fixture-only",
      cwd: import.meta.dir,
      project: import.meta.dir,
      clients: 0,
    };
  };
  app.backend.attachCommand = () => [
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-i",
  ];
} else if (relay !== "-")
  app.backend.attachCommand = (ref) => [
    "/usr/bin/python3",
    relay,
    trace,
    app.backend.launcher,
    "attach",
    ref.name,
  ];
const instrumented = new Set<number>();
const terminals = new Set<object>();
const attach = app.attachRemote.bind(app);
app.attachRemote = async (...args) => {
  await attach(...args);
  if (relay !== "-" && relay !== "local") return;
  for (const s of app.shells) {
    if (instrumented.has(s.child.pid)) continue;
    instrumented.add(s.child.pid);
    if (!terminals.has(s.terminal)) {
      terminals.add(s.terminal);
      const tw = s.terminal.write.bind(s.terminal);
      s.terminal.write = (data) => {
        record("output", data);
        return tw(data);
      };
    }
    s.adapter.write = (data) => {
      record("input", data);
      if (!s.adapter.closed) {
        const accepted = s.child.terminal?.write(data);
        record("accepted", String(accepted));
      }
    };
  }
};
if (relay === "-") await app.refreshSessions();
await app.attachRemote(name);
const state = setInterval(
  () =>
    writeFileSync(
      trace + ".state.json",
      JSON.stringify({
        appPid: process.pid,
        title: `Tokiwa input proof ${process.pid}`,
        width: renderer.width,
        height: renderer.height,
        active: app.shells[app.active]?.name,
        view: app.view,
        error: app.error,
        shells: app.shells.map((s) => ({
          name: s.name,
          pid: s.child.pid,
          exited: s.exited,
          screen: s.terminal.screen().text,
        })),
      }),
    ),
  200,
);
const timer = setTimeout(() => app.close(), 600000);
renderer.on("destroy", () => {
  clearTimeout(timer);
  clearInterval(state);
});
