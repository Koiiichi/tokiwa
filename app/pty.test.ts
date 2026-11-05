import { expect, test } from "bun:test";
import { localShellCommand, PtyAdapter } from "./pty";

test("remote PTY passes bytes before the transport configures its terminal", async () => {
  let output = "";
  const adapter = new PtyAdapter(
    "remote",
    [
      "/usr/bin/python3",
      "-c",
      "import os; os.write(1,b'READY'); os.write(1,os.read(0,100))",
    ],
    {
      data: (bytes) => {
        output += new TextDecoder().decode(bytes);
      },
      exit: () => {},
    },
    import.meta.dir,
  );
  try {
    const deadline = Date.now() + 2000;
    while (!output.includes("READY") && Date.now() < deadline)
      await Bun.sleep(10);
    expect(output).toContain("READY");
    const reply = "\x1b[?62;22c";
    adapter.write(reply);
    const completed = await Promise.race([
      adapter.child.exited.then(() => true),
      Bun.sleep(500).then(() => false),
    ]);
    expect(completed).toBe(true);
    expect(output).toBe("READY" + reply);
  } finally {
    adapter.closeTransport();
    await adapter.child.exited;
  }
});

test("a remote transport's line feed reaches the emulator unchanged; a local shell keeps CR LF", async () => {
  // tmux sets its own terminal raw and sends a bare line feed to move down one row in the same
  // column. A PTY that translates it to CR LF moves the cursor to column 0 as well. The child
  // first runs the Session Manager plugin's own terminal setup, `stty cbreak` and `stty -echo`:
  // on macOS, cbreak turns opost back on.
  // Before tmux takes the alternate screen, plain line feeds of the launcher and the plugin get a
  // carriage return, as a terminal with onlcr gives them; after it, tmux's bytes pass unchanged.
  const run = async (kind: "remote" | "local") => {
    let output = "";
    const adapter = new PtyAdapter(
      kind,
      [
        "/bin/sh",
        "-c",
        "stty cbreak; stty -echo; printf 'one\\ntwo\\n'; sleep 0.2; printf '\\033[?1049hA\\nB'",
      ],
      {
        data: (bytes) => {
          output += new TextDecoder().decode(bytes);
        },
        exit: () => {},
      },
      import.meta.dir,
    );
    await adapter.child.exited;
    await Bun.sleep(50);
    adapter.closeTransport();
    return output;
  };
  expect(await run("remote")).toBe("one\r\ntwo\r\n\x1b[?1049hA\nB");
  expect(await run("local")).toBe("one\r\ntwo\r\n\x1b[?1049hA\r\nB");
});

test("hidden terminal geometry preserves the last usable PTY size", async () => {
  let output = "";
  const adapter = new PtyAdapter(
    "remote",
    [
      "/usr/bin/python3",
      "-c",
      "import os; os.write(1,b'READY'); os.read(0,1); s=os.get_terminal_size(0); os.write(1,('SIZE:%d:%d' % (s.columns,s.lines)).encode())",
    ],
    {
      data: (bytes) => {
        output += new TextDecoder().decode(bytes);
      },
      exit: () => {},
    },
    import.meta.dir,
  );
  try {
    adapter.resize(62, 18);
    adapter.resize(0, 0);
    const deadline = Date.now() + 2000;
    while (!output.includes("READY") && Date.now() < deadline)
      await Bun.sleep(10);
    expect(output).toContain("READY");
    adapter.write("x");
    await adapter.child.exited;
    expect(output).toContain("SIZE:62:18");
  } finally {
    adapter.closeTransport();
    await adapter.child.exited;
  }
});

/** Run a child that optionally enters the alternate screen, then reports the bytes it reads. */
async function redrawRequests(kind: "local" | "remote", enter: boolean) {
  let output = "";
  const script = [
    "import os, select, sys, time",
    `os.write(1, ${enter ? "b'\\x1b[?1049h'" : "b''"} + b'READY')`,
    "data, end = b'', time.time() + 1.2",
    "while time.time() < end:",
    "    if select.select([0], [], [], 0.05)[0]: data += os.read(0, 100)",
    "os.write(1, b'GOT:' + data.hex().encode() + b':END')",
  ].join("\n");
  const adapter = new PtyAdapter(
    kind,
    ["/usr/bin/python3", "-c", script],
    {
      data: (bytes) => {
        output += new TextDecoder().decode(bytes);
      },
      exit: () => {},
    },
    import.meta.dir,
  );
  const delay = PtyAdapter.redrawDelayMs;
  PtyAdapter.redrawDelayMs = 200;
  try {
    const deadline = Date.now() + 2000;
    while (!output.includes("READY") && Date.now() < deadline)
      await Bun.sleep(10);
    // Two quick size changes give one request after the size settles.
    adapter.resize(70, 20);
    await Bun.sleep(50);
    adapter.resize(71, 20);
    await adapter.child.exited;
    return output.match(/GOT:([0-9a-f]*):END/)?.[1] ?? "missing";
  } finally {
    PtyAdapter.redrawDelayMs = delay;
    adapter.closeTransport();
  }
}

test("a remote transport asks tmux once to redraw after its size settles", async () => {
  // Ctrl+B r runs refresh-client in the default tmux key table.
  expect(await redrawRequests("remote", true)).toBe("0272");
});

test("no redraw request reaches a transport before tmux draws or a local shell", async () => {
  expect(await redrawRequests("remote", false)).toBe("");
  expect(await redrawRequests("local", true)).toBe("");
});

/**
 * Run a stand-in for tmux: it enters the alternate screen, sends `burst` bytes and reports every
 * byte that it read.
 */
async function burstInput(burst: number) {
  let output = "";
  const script = [
    "import os, select, time",
    "os.write(1, b'\\x1b[?1049hREADY')",
    "time.sleep(0.05)",
    `os.write(1, b'x' * ${burst})`,
    "data, end = b'', time.time() + 1.5",
    "while time.time() < end:",
    "    if select.select([0], [], [], 0.02)[0]:",
    "        data += os.read(0, 100)",
    "os.write(1, b'GOT:' + data.hex().encode() + b':END')",
  ].join("\n");
  const adapter = new PtyAdapter(
    "remote",
    ["/usr/bin/python3", "-c", script],
    {
      data: (bytes) => {
        output += new TextDecoder().decode(bytes);
      },
      exit: () => {},
    },
    import.meta.dir,
  );
  try {
    await adapter.child.exited;
    return output.match(/GOT:([0-9a-f]*):END/)?.[1] ?? "missing";
  } finally {
    adapter.closeTransport();
  }
}

test("a burst of remote output sends nothing to tmux", async () => {
  // The rows arrive at the right columns, so output never asks tmux for a redraw.
  expect(await burstInput(4000)).toBe("");
});

test("startup reply filter keeps every other terminal reply", async () => {
  const { withoutStartupQueryReplies } = await import("./pty");
  const text = (s: string) =>
    Buffer.from(withoutStartupQueryReplies(Buffer.from(s, "latin1"))).toString(
      "latin1",
    );
  const kept =
    "\x1b[?1016;2$y\x1b[?0u\x1b[12;40R\x1b]11;rgb:0000/0000/0000\x1b\\";
  expect(
    text(
      "\x1b[?62;22c\x1b[>1;0;0c\x1bP>|libghostty\x1b\\" +
        kept +
        "\x1bP>|x\x07\x1b[?2026;2$y",
    ),
  ).toBe(kept);
  const plain = Buffer.from("typed text");
  expect(withoutStartupQueryReplies(plain)).toBe(plain);
});

test("with TOKIWA_RECORD_DIR a remote transport records its raw output and size changes", async () => {
  const { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = mkdtempSync(join(tmpdir(), "tokiwa-record-"));
  const previous = process.env.TOKIWA_RECORD_DIR;
  process.env.TOKIWA_RECORD_DIR = folder;
  try {
    let exited: () => void = () => {};
    const done = new Promise<void>((resolve) => (exited = resolve));
    const adapter = new PtyAdapter(
      "remote",
      ["/bin/sh", "-c", "sleep 0.2; printf 'RECORDED\\033[2J'"],
      { data: () => {}, exit: () => exited() },
      process.cwd(),
    );
    adapter.resize(100, 30);
    await done;
    const files = readdirSync(folder).sort();
    // The files hold session text: only the user can read them.
    for (const name of files)
      expect(statSync(join(folder, name)).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(files.map((f) => f.split(".").at(-1))).toEqual(["bytes", "sizes"]);
    expect(readFileSync(join(folder, files[0]), "latin1")).toContain(
      "RECORDED\x1b[2J",
    );
    expect(readFileSync(join(folder, files[1]), "utf8")).toBe("0 100 30\n");
    // A local transport records nothing.
    const local = new PtyAdapter(
      "local",
      ["/bin/sh", "-c", "printf local"],
      { data: () => {}, exit: () => {} },
      process.cwd(),
    );
    await local.child.exited;
    expect(readdirSync(folder)).toHaveLength(2);
  } finally {
    if (previous === undefined) delete process.env.TOKIWA_RECORD_DIR;
    else process.env.TOKIWA_RECORD_DIR = previous;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a program's clipboard write reaches the app, also split across reads; its mouse mode is followed", async () => {
  const copied: string[] = [];
  const b64 = Buffer.from("copied ● text").toString("base64");
  const half = Math.floor(b64.length / 2);
  const script = [
    "import os, time",
    "os.write(1, b'\\x1b[?1000h\\x1b[?1006h')",
    `os.write(1, b'\\x1b]52;c;${b64.slice(0, half)}')`,
    "time.sleep(0.2)",
    `os.write(1, b'${b64.slice(half)}\\x07')`,
    // A clipboard read request carries no text and copies nothing.
    "os.write(1, b'\\x1b]52;c;?\\x07READY')",
    "time.sleep(0.3)",
  ].join("\n");
  let output = "";
  const adapter = new PtyAdapter(
    "local",
    ["/usr/bin/python3", "-c", script],
    {
      data: (bytes) => {
        output += new TextDecoder().decode(bytes);
      },
      exit: () => {},
      clipboard: (text) => copied.push(text),
    },
    import.meta.dir,
  );
  try {
    const deadline = Date.now() + 3000;
    while (!output.includes("READY") && Date.now() < deadline)
      await Bun.sleep(10);
    expect(copied).toEqual(["copied ● text"]);
    expect(adapter.mouseTracking).toBe(true);
    await adapter.child.exited;
  } finally {
    adapter.closeTransport();
  }
  const off = new PtyAdapter(
    "local",
    ["/bin/sh", "-c", "printf '\\033[?1002h\\033[?1002lDONE'"],
    { data: () => {}, exit: () => {} },
    import.meta.dir,
  );
  await off.child.exited;
  await Bun.sleep(50);
  expect(off.mouseTracking).toBe(false);
  off.closeTransport();
});

test("a tokiwa-open link request reaches the app, also split across reads", async () => {
  const links: string[] = [];
  const b64 = Buffer.from(
    "https://github.com/openai/codex/releases/latest",
  ).toString("base64");
  const half = Math.floor(b64.length / 2);
  const script = [
    "import os, time",
    `os.write(1, b'\\x1b]7717;open;${b64.slice(0, half)}')`,
    "time.sleep(0.2)",
    `os.write(1, b'${b64.slice(half)}\\x1b\\\\READY')`,
    "time.sleep(0.3)",
  ].join("\n");
  let output = "";
  const adapter = new PtyAdapter(
    "local",
    ["/usr/bin/python3", "-c", script],
    {
      data: (bytes) => {
        output += new TextDecoder().decode(bytes);
      },
      exit: () => {},
      open: (url) => links.push(url),
    },
    import.meta.dir,
  );
  try {
    const deadline = Date.now() + 3000;
    while (!output.includes("READY") && Date.now() < deadline)
      await Bun.sleep(10);
    expect(links).toEqual(["https://github.com/openai/codex/releases/latest"]);
    await adapter.child.exited;
  } finally {
    adapter.closeTransport();
  }
});

test("a local shell is the user's login shell; TOKIWA_LOCAL_SHELL replaces it", () => {
  expect(localShellCommand({ SHELL: "/bin/bash" })).toEqual(["/bin/bash", "-l"]);
  expect(localShellCommand({ SHELL: "/bin/zsh" })).toEqual(["/bin/zsh", "-l"]);
  // A missing or unusable SHELL falls back to zsh.
  expect(localShellCommand({})).toEqual(["/bin/zsh", "-l"]);
  expect(localShellCommand({ SHELL: "zsh" })).toEqual(["/bin/zsh", "-l"]);
  expect(localShellCommand({ SHELL: "/no/such/shell" })).toEqual(["/bin/zsh", "-l"]);
  expect(
    localShellCommand({ SHELL: "/bin/bash", TOKIWA_LOCAL_SHELL: "/bin/zsh -f" }),
  ).toEqual(["/bin/zsh", "-f"]);
});

test("a local shell inherits the environment without the outer terminal's identity; a remote transport does not", async () => {
  const run = async (kind: "local" | "remote") => {
    let output = "";
    const adapter = new PtyAdapter(
      kind,
      [
        "/bin/sh",
        "-c",
        'printf "<%s|%s|%s|%s|%s>" "${TOKIWA_TEST_MARK:-none}" "${TERM_PROGRAM:-none}" "${GHOSTTY_RESOURCES_DIR:-none}" "${TMUX:-none}" "$TERM"',
      ],
      {
        data: (bytes) => {
          output += new TextDecoder().decode(bytes);
        },
        exit: () => {},
      },
      import.meta.dir,
    );
    await adapter.child.exited;
    return output.match(/<[^>]*>/)?.[0];
  };
  const saved = { ...process.env };
  Object.assign(process.env, {
    TOKIWA_TEST_MARK: "kept",
    TERM_PROGRAM: "ghostty",
    GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app",
    TMUX: "/tmp/tmux-501/default,1,0",
  });
  try {
    expect(await run("local")).toBe("<kept|none|none|none|xterm-256color>");
    expect(await run("remote")).toBe("<none|none|none|none|xterm-256color>");
  } finally {
    for (const key of ["TOKIWA_TEST_MARK", "TERM_PROGRAM", "GHOSTTY_RESOURCES_DIR", "TMUX"])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  }
});
