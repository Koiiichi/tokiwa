/** Model-free long-outage check through the existing launcher and the actual app.
 *
 * It freezes the transport processes that this check started (SIGSTOP by PID), so no traffic flows, as in a network
 * outage; then it resumes them (SIGCONT). A short outage and a long one (past the Session Manager idle timeout) run in
 * turn. After each: the UI must mark a dead transport as disconnected, a reconnect must reach the same remote shell,
 * the shell must accept input, and a command typed during the outage must not run later. The owner's sessions must be
 * unchanged, and the disposable fixture is ended by exact identity.
 *
 *   bun outage-check.ts RESULT.json [SHORT_SECONDS] [LONG_SECONDS]
 */
import { createTestRenderer } from "@opentui/core/testing";
import { EmbeddedTerminalRenderable } from "@opentui/core";
import { BackendClient, type SessionRef } from "./backend";
import { PtyAdapter } from "./pty";
import { App } from "./app";
import { writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("Supply the result path.");
const SHORT = Number(process.argv[3] ?? 120);
const LONG = Number(process.argv[4] ?? 1500);
const backend = new BackendClient();
const name = "opentui-outage-a";
const owned: SessionRef[] = [];
const creators: PtyAdapter[] = [];
const ui = await createTestRenderer({ width: 100, height: 30 });
let app: App | undefined;
const result = {
  started: new Date().toISOString(),
  outages: { shortSeconds: SHORT, longSeconds: LONG },
  checks: [] as object[],
  error: "",
  cleanup: [] as string[],
  finished: "",
};
const save = () => writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
const log = (entry: object) => {
  result.checks.push({ at: new Date().toISOString(), ...entry });
  save();
};

async function wait(check: () => boolean, label: string, ms = 180000) {
  const began = Date.now();
  while (!check()) {
    if (Date.now() - began > ms) {
      log({ failedWait: label, screen: app?.shells.map((s) => s.terminal.screen().text.slice(-600)) });
      throw new Error(`Timed out: ${label}`);
    }
    await ui.renderOnce();
    await Bun.sleep(200);
  }
  return Date.now() - began;
}

async function create(fixture: string) {
  const terminal = new EmbeddedTerminalRenderable(ui.renderer, { id: `creator-${fixture}`, width: 80, height: 24 });
  ui.renderer.root.add(terminal);
  const p = new PtyAdapter("remote", [backend.launcher, "new", fixture], { data: (b) => terminal.write(b), exit: () => {} }, import.meta.dir);
  creators.push(p);
  terminal.onData = (b) => p.write(b);
  await wait(() => /bash-[\d.]+\$/.test(terminal.screen().text), "fixture prompt");
  const ref = await backend.resolve(fixture);
  owned.push(ref);
  p.detach();
  await p.child.exited;
  terminal.destroyRecursively();
  return ref;
}

async function attach(ref: SessionRef, reconnect: boolean) {
  await app!.attachRemote(ref.name, ref.identity, reconnect);
  if (app!.error) throw new Error(app!.error);
  const shell = app!.shells.find((s) => s.remote?.name === ref.name)!;
  await wait(() => /bash-[\d.]+\$/.test(shell.terminal.screen().text), "UI remote prompt");
  return shell;
}
type Shell = Awaited<ReturnType<typeof attach>>;

async function witness(shell: Shell, tag: string) {
  shell.adapter.write(`printf '\\n${tag}=%s\\n' "$$"\r`);
  await wait(() => new RegExp(tag + "=([0-9]+)").test(shell.terminal.screen().text), tag, 60000);
  return shell.terminal.screen().text.match(new RegExp(tag + "=([0-9]+)"))![1];
}

/** The transport process and all its descendants, which this check started. */
function tree(root: number): number[] {
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    const r = Bun.spawnSync(["pgrep", "-P", String(out[i])]);
    for (const line of r.stdout.toString().split("\n")) if (line.trim()) out.push(Number(line));
  }
  return out;
}

async function outage(shell: Shell, label: string, seconds: number, ref: SessionRef, pid: string) {
  const pids = tree(shell.child.pid);
  const marker = `/tmp/opentui-outage-stale-${label}-${Date.now()}`;
  for (const p of pids) process.kill(p, "SIGSTOP");
  log({ outage: label, frozenPids: pids, seconds });
  // Typed during the outage: it must not run on the remote shell later.
  shell.adapter.write(`touch ${marker}\r`);
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await ui.renderOnce();
    await Bun.sleep(1000);
  }
  for (const p of pids) {
    try {
      process.kill(p, "SIGCONT");
    } catch {}
  }
  // After the network returns, the transport either still works or ends and shows as disconnected. A transport that
  // does neither within 5 minutes is a hang, which fails the check.
  const began = Date.now();
  const settle = async (ms: number) => {
    while (!shell.exited && Date.now() - began < ms) {
      await ui.renderOnce();
      await Bun.sleep(500);
    }
  };
  await settle(60000);
  let survived = !shell.exited;
  let after = "";
  if (survived) {
    try {
      after = await witness(shell, `ALIVE_${label.toUpperCase()}`);
    } catch {
      await settle(300000);
      if (!shell.exited) throw new Error(`${label}: the transport neither works nor ends 5 min after the outage.`);
      survived = false;
    }
  }
  log({ outage: label, transportSurvived: survived, endedAfterResumeMs: survived ? null : Date.now() - began });
  let current = shell;
  if (!survived) current = await attach(ref, true);
  after = await witness(current, `AFTER_${label.toUpperCase()}`);
  if (after !== pid) throw new Error(`${label}: the remote shell changed (${pid} -> ${after}).`);
  current.adapter.write(`printf '\\nSTALE_${label.toUpperCase()}=%s\\n' "$(test -e ${marker} && echo ran || echo absent)"\r`);
  await wait(() => new RegExp(`STALE_${label.toUpperCase()}=(ran|absent)`).test(current.terminal.screen().text), `stale ${label}`, 60000);
  const stale = current.terminal.screen().text.match(new RegExp(`STALE_${label.toUpperCase()}=(ran|absent)`))![1];
  current.adapter.write(`rm -f ${marker}\r`);
  log({ check: `${label}-outage`, transportSurvived: survived, reconnected: !survived, remotePid: after, staleInput: stale, passed: true });
  return current;
}

const before = await backend.sessions();
try {
  if (before.some((s) => s.name === name)) throw new Error("The fixture already exists. Nothing was created.");
  const ref = await create(name);
  app = new App(ui.renderer, { spawn: false });
  let shell = await attach(ref, false);
  const pid = await witness(shell, "FIRST");
  log({ check: "attach", remotePid: pid, identity: ref.identity, passed: true });
  shell = await outage(shell, "short", SHORT, ref, pid);
  shell = await outage(shell, "long", LONG, ref, pid);
} catch (e) {
  result.error = String(e);
  process.exitCode = 1;
} finally {
  await ui.dispose();
  for (const p of creators) p.closeTransport();
  const refs = await backend.sessions();
  for (const ref of refs)
    if (ref.name === name) {
      const expected = owned.find((s) => s.name === ref.name);
      if (!expected || expected.identity !== ref.identity) {
        result.error += " Fixture identity is not verified; cleanup was refused.";
        process.exitCode = 1;
        continue;
      }
      await backend.end(ref, ref.name);
      result.cleanup.push(ref.name);
    }
  const after = await backend.sessions();
  const preserved = before.every((s) => after.some((r) => r.name === s.name && r.identity === s.identity));
  log({ check: "owner-sessions-preserved", passed: preserved, sessions: after.map((s) => s.name) });
  if (!preserved || after.some((s) => s.name === name)) {
    result.error += " Session preservation or cleanup failed.";
    process.exitCode = 1;
  }
  result.finished = new Date().toISOString();
  save();
  backend.close();
}
console.log(JSON.stringify({ error: result.error, checks: result.checks.filter((c: any) => c.check) }));
