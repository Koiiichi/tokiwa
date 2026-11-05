import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "./app";

// A local stand-in for a remote tmux client. It sends the startup queries that tmux
// sends (DA1, DA2, XTVERSION, mode 2026, OSC 10 and OSC 11), reads replies for one second and
// prints the received bytes as hex. No network, launcher or model is involved.
const fakeTmuxClient = [
  "/usr/bin/python3",
  "-c",
  [
    "import os,sys,time,select,tty",
    "tty.setraw(0)",
    "os.write(1,b'\\x1b[c\\x1b[>c\\x1b[>q\\x1b[?2026$p\\x1b]10;?\\x1b\\\\\\x1b]11;?\\x1b\\\\')",
    "got=b'';end=time.time()+1",
    "while time.time()<end:",
    " r,_,_=select.select([0],[],[],0.05)",
    " if r: got+=os.read(0,4096)",
    "os.write(1,b'\\r\\nGOT:'+got.hex().encode()+b':END\\r\\n')",
  ].join("\n"),
];

async function received(
  app: App,
  t: Awaited<ReturnType<typeof createTestRenderer>>,
) {
  app.active = 0;
  app.show("shell");
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await t.renderOnce();
    // The hex report wraps across screen rows. Join the rows before matching.
    const text = app.shells[0]?.terminal.screen().lines.join("") ?? "";
    const match = /GOT:([0-9a-f]*):END/.exec(text);
    if (match) return Buffer.from(match[1], "hex").toString("latin1");
    await Bun.sleep(20);
  }
  throw new Error("The fake tmux client did not report its input.");
}

function expectSafeReplies(input: string) {
  // tmux injects late startup query replies into the pane as keystrokes.
  expect(input).not.toContain("\x1b[?");
  expect(input).not.toContain("\x1b[>");
  expect(input).not.toContain("\x1bP>|");
  expect(input).not.toContain("2026;");
  // tmux parses colour replies at any time. Keep them.
  expect(input).toContain("\x1b]10;rgb:");
  expect(input).toContain("\x1b]11;rgb:");
}

test("remote attach does not send startup query replies that tmux can receive late", async () => {
  const t = await createTestRenderer({ width: 100, height: 30 });
  const app = new App(t.renderer, { spawn: false });
  app.backend.resolve = async (name) => ({
    name,
    identity: "1:$2:3",
    cwd: "/work",
    project: "/work",
    clients: 0,
  });
  app.backend.attachCommand = () => fakeTmuxClient;
  try {
    await app.attachRemote("fixture-a");
    expectSafeReplies(await received(app, t));
  } finally {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  }
});

test("remote auxiliary shell does not send startup query replies", async () => {
  const t = await createTestRenderer({ width: 100, height: 30 });
  const app = new App(t.renderer, { spawn: false });
  try {
    app.startShell("fixture-b", true, import.meta.dir, fakeTmuxClient);
    expectSafeReplies(await received(app, t));
  } finally {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  }
});

test("local shell keeps every terminal reply", async () => {
  const t = await createTestRenderer({ width: 100, height: 30 });
  const app = new App(t.renderer, { spawn: false });
  try {
    app.startShell("fixture-c", false, import.meta.dir, fakeTmuxClient);
    const input = await received(app, t);
    expect(input).toContain("\x1b[?62;22c");
    expect(input).toContain("\x1b[?2026;");
    expect(input).toContain("\x1b]11;rgb:");
  } finally {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  }
});
