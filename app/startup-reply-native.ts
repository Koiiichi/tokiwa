/** Model-free native check of late startup replies. It uses a private local tmux server only. */
import { createCliRenderer } from "@opentui/core";
import { writeFileSync } from "node:fs";
import { App } from "./app";

const [mode, delayText, socket, output] = process.argv.slice(2);
if (mode !== "filtered" && mode !== "unfiltered")
  throw new Error("Use filtered or unfiltered mode.");
const delay = Number(delayText);
if (!Number.isFinite(delay) || delay < 0 || delay > 20000)
  throw new Error("Use a reply delay from 0 to 20000 milliseconds.");
if (!socket?.endsWith(".sock") || !output)
  throw new Error("Supply a private tmux socket path and an evidence path.");

const tmux = "/opt/homebrew/bin/tmux";
const name = `startup-${mode}`;
const started = performance.now();
const elapsed = () => Math.round(performance.now() - started);
const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  targetFps: 30,
});
const title = `Tokiwa startup reply ${mode} ${process.pid}`;
process.stdout.write(`\x1b]2;${title}\x07`);
const app = new App(renderer, { spawn: false, layout: "terminal" });
app.backend.resolve = async (n) => ({
  name: n,
  identity: "0:$0:0",
  cwd: import.meta.dir,
  project: import.meta.dir,
  clients: 0,
});
app.backend.attachCommand = () => [
  tmux,
  "-S",
  socket,
  "-f",
  "/dev/null",
  "new-session",
  "-A",
  "-s",
  name,
  "/bin/bash --noprofile --norc",
];

const replies: { at: number; sentAt: number; hex: string }[] = [];
await app.attachRemote(name);
const shell = app.shells[0];
const forward = shell.terminal.onData!;
// Delay each emulator reply past the five-second tmux query timeout.
// Unfiltered mode writes the reply directly, as the candidate did before the fix.
shell.terminal.onData = (data, source) => {
  if (source !== "response") return forward(data, source);
  const copy = Uint8Array.from(data);
  const entry = { at: elapsed(), sentAt: -1, hex: "" };
  replies.push(entry);
  setTimeout(() => {
    entry.sentAt = elapsed();
    entry.hex = Buffer.from(copy).toString("hex");
    if (mode === "filtered") forward(copy, source);
    else shell.adapter.write(copy);
  }, delay);
};

const pane = async () => {
  const p = Bun.spawn([tmux, "-S", socket, "capture-pane", "-p", "-t", name], {
    stdout: "pipe",
  });
  const text = await new Response(p.stdout).text();
  await p.exited;
  return text.trimEnd();
};
await Bun.sleep(delay + 2500);
const beforeEnter = await pane();
// Run what the shell holds, as a user pressing Enter at the prompt would.
await Bun.spawn([tmux, "-S", socket, "send-keys", "-t", name, "Enter"]).exited;
await Bun.sleep(800);
const afterEnter = await pane();
writeFileSync(
  output,
  JSON.stringify(
    {
      mode,
      delay_ms: delay,
      title,
      app_pid: process.pid,
      tmux: socket,
      replies,
      pane_before_enter: beforeEnter,
      pane_after_enter: afterEnter,
      leaked:
        /62;22c|1;0;0c|libghostty|command not found/.test(beforeEnter) ||
        /command not found/.test(afterEnter),
    },
    null,
    2,
  ),
);
// Keep the window open for a native capture, then end only the private tmux server.
setTimeout(async () => {
  await Bun.spawn([tmux, "-S", socket, "kill-server"]).exited;
  app.close();
  renderer.destroy();
  process.exit(0);
}, 15000);
