/** Model-free validation through the existing launcher and the actual app. */
import { createTestRenderer } from "@opentui/core/testing";
import { EmbeddedTerminalRenderable } from "@opentui/core";
import { BackendClient, type SessionRef } from "./backend";
import { PtyAdapter } from "./pty";
import { App } from "./app";
import { writeFileSync } from "node:fs";
const path = process.argv[2];
if (!path) throw new Error("Supply the result path.");
const backend = new BackendClient();
const names = ["opentui-reconnect-a", "opentui-reconnect-b"];
const owned: SessionRef[] = [];
const creators: PtyAdapter[] = [];
let ui = await createTestRenderer({ width: 100, height: 30 });
let app: App | undefined;
const result = {
  started: new Date().toISOString(),
  checks: [] as object[],
  error: "",
  cleanup: [] as string[],
};
const save = () => writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
async function wait(check: () => boolean, label: string, ms = 180000) {
  const began = Date.now();
  const until = began + ms;
  while (!check()) {
    if (Date.now() > until) {
      result.checks.push({
        failedWait: label,
        screens: app?.shells.map((s) => ({
          name: s.name,
          screen: s.terminal.screen().text,
          rows: s.terminal.screen().rows,
        })),
      });
      save();
      throw new Error(`Timed out: ${label}`);
    }
    await ui.renderOnce();
    await Bun.sleep(100);
  }
  result.checks.push({ wait: label, milliseconds: Date.now() - began });
  save();
}
async function exited(p: PtyAdapter) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p.child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out: owned transport exit")),
          15000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function create(name: string, from?: string) {
  const terminal = new EmbeddedTerminalRenderable(ui.renderer, {
    id: `creator-${name}`,
    width: 80,
    height: 24,
  });
  ui.renderer.root.add(terminal);
  const p = new PtyAdapter(
    "remote",
    [backend.launcher, "new", name, ...(from ? ["--from", from] : [])],
    { data: (b) => terminal.write(b), exit: () => {} },
    import.meta.dir,
  );
  creators.push(p);
  terminal.onData = (b) => p.write(b);
  await wait(
    () => /bash-[\d.]+\$/.test(terminal.screen().text),
    "fixture prompt",
  );
  const ref = await backend.resolve(name);
  owned.push(ref);
  p.detach();
  await exited(p);
  terminal.destroyRecursively();
  return ref;
}
async function attach(ref: SessionRef, reconnect = false) {
  await app!.attachRemote(ref.name, ref.identity, reconnect);
  if (app!.error) throw new Error(app!.error);
  const shell = app!.shells.find((s) => s.remote?.name === ref.name)!;
  await wait(
    () => /bash-[\d.]+\$/.test(shell.terminal.screen().text),
    "UI remote prompt",
  );
  return shell;
}
async function witness(shell: Awaited<ReturnType<typeof attach>>, tag: string) {
  shell.adapter.write(`printf '\\n${tag}=%s\\n' "$$"\r`);
  await wait(
    () => new RegExp(tag + "=([0-9]+)").test(shell.terminal.screen().text),
    tag,
  );
  return shell.terminal.screen().text.match(new RegExp(tag + "=([0-9]+)"))![1];
}
const before = await backend.sessions();
try {
  if (before.some((s) => names.includes(s.name)))
    throw new Error("A fixture already exists. Nothing was created.");
  const a = await create(names[0]);
  app = new App(ui.renderer, { spawn: false });
  let shell = await attach(a);
  const pid = await witness(shell, "FIRST");
  const transport = shell.child.pid;
  shell = await attach(a, true);
  if (
    shell.child.pid === transport ||
    (await witness(shell, "RECONNECT")) !== pid
  )
    throw new Error("Reconnect identity changed or transport was reused.");
  result.checks.push({
    check: "explicit-reconnect",
    remotePid: pid,
    identity: a.identity,
    passed: true,
  });
  save();
  const b = await create(names[1], names[0]);
  const other = await attach(b);
  const otherPid = await witness(other, "OTHER");
  if (otherPid === pid)
    throw new Error("Independent sessions share a shell PID.");
  const retainedTransport = shell.child.pid;
  await attach(a);
  if (shell.child.pid !== retainedTransport)
    throw new Error("Switching replaced a transport.");
  result.checks.push({
    check: "independent-switching",
    pids: [pid, otherPid],
    passed: true,
  });
  save();
  const children = app.shells.map((s) => s.adapter);
  await ui.dispose();
  for (const p of children) await exited(p);
  ui = await createTestRenderer({ width: 100, height: 30 });
  app = new App(ui.renderer, { spawn: false });
  shell = await attach(a);
  if ((await witness(shell, "REOPEN")) !== pid)
    throw new Error("UI restart changed the remote shell.");
  result.checks.push({
    check: "UI-close-reopen",
    remotePid: pid,
    passed: true,
  });
  save();
  shell.adapter.closeTransport();
  await exited(shell.adapter);
  shell = await attach(a, true);
  if ((await witness(shell, "INTERRUPT")) !== pid)
    throw new Error("Transport interruption changed the remote shell.");
  result.checks.push({
    check: "transport-interruption",
    remotePid: pid,
    passed: true,
  });
  save();
  ui.resize(48, 18);
  await ui.renderOnce();
  await Bun.sleep(1000);
  shell.adapter.write("printf '\\nSZ='; stty size\r");
  await wait(
    () => /SZ=\s*\d+\s+\d+/.test(shell.terminal.screen().text),
    "pane size",
  );
  const size = shell.terminal.screen().text.match(/SZ=\s*(\d+)\s+(\d+)/)!;
  const screen = shell.terminal.screen();
  if (+size[2] !== screen.columns || +size[1] !== screen.rows - 1)
    throw new Error(
      `Pane dimensions ${size[1]} ${size[2]} do not match terminal ${screen.rows} ${screen.columns} with one tmux status row.`,
    );
  result.checks.push({
    check: "resize",
    pane: [+size[1], +size[2]],
    terminal: [screen.rows, screen.columns],
    passed: true,
  });
} catch (e) {
  result.error = String(e);
  process.exitCode = 1;
} finally {
  await ui.dispose();
  for (const p of creators) p.closeTransport();
  const refs = await backend.sessions();
  for (const ref of refs)
    if (names.includes(ref.name)) {
      const expected = owned.find((s) => s.name === ref.name);
      if (!expected || expected.identity !== ref.identity) {
        result.error +=
          " Fixture identity is not verified; cleanup was refused.";
        process.exitCode = 1;
        continue;
      }
      await backend.end(ref, ref.name);
      result.cleanup.push(ref.name);
    }
  const after = await backend.sessions();
  result.checks.push({
    check: "owner-sessions-preserved",
    passed: before.every((s) =>
      after.some((r) => r.name === s.name && r.identity === s.identity),
    ),
    sessions: after.map((s) => ({ name: s.name, identity: s.identity })),
  });
  if (
    !before.every((s) =>
      after.some((r) => r.name === s.name && r.identity === s.identity),
    ) ||
    after.some((s) => names.includes(s.name))
  ) {
    result.error += " Session preservation or cleanup failed.";
    process.exitCode = 1;
  }
  save();
  backend.close();
}
console.log(JSON.stringify(result));
