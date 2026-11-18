import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./app";
import { BackendClient, LauncherError } from "./backend";

const pause = (ms = 60) => Bun.sleep(ms);
const REF = {
  name: "fixture",
  identity: "1:$2:3",
  cwd: "/work",
  project: "/work",
  clients: 1,
};
const BRACKETED = "\x1b[200~/host/path.png\x1b[201~";

async function setup(opts: {
  remote?: boolean;
  image?: "none" | number;
  runner?: (args: string[]) => Promise<string>;
}) {
  const t = await createTestRenderer({ width: 80, height: 24 });
  const dir = mkdtempSync(join(tmpdir(), "paste-test-"));
  const calls: string[][] = [];
  const files: string[] = [];
  const backend = new BackendClient("/fixture/tokiwa", async (args) => {
    calls.push(args);
    if (opts.runner) return opts.runner(args);
    return JSON.stringify({ path: "/host/path.png" });
  });
  let reads = 0;
  const app = new App(t.renderer, {
    spawn: false,
    backend,
    readImage: async (d: string) => {
      reads++;
      if (opts.image === "none") return undefined;
      const file = join(d, "clipboard-test.png");
      writeFileSync(file, Buffer.alloc(typeof opts.image === "number" ? opts.image : 10));
      files.push(file);
      return file;
    },
  });
  const shell = app.startShell("fixture")!;
  if (opts.remote !== false) shell.remote = REF;
  app.focusPaneOf("fixture");
  const written: string[] = [];
  shell.adapter.write = (data: string) => void written.push(data);
  const footer = () => {
    app.drawFooter();
    return app.footerNotice?.text ?? "";
  };
  const cmdV = () => t.renderer.keyInput.emit("keypress", {
    name: "v", super: true, ctrl: false, shift: false, meta: false, option: false,
    sequence: "v", preventDefault() {}, stopPropagation() {},
  } as never);
  return { t, app, shell, calls, files, written, footer, cmdV, reads: () => reads, dir };
}

test("Cmd+V in a remote view pastes the host path as a bracketed paste", async () => {
  const s = await setup({});
  try {
    s.cmdV();
    await pause();
    expect(s.calls).toEqual([["paste-image", "fixture", "1:$2:3", s.files[0]]]);
    expect(s.written).toEqual([BRACKETED]);
    expect(existsSync(s.files[0])).toBe(false);
  } finally {
    await s.t.dispose();
  }
});

test("a launcher failure writes nothing and says so", async () => {
  const s = await setup({
    runner: async () => {
      throw new LauncherError(
        "Launcher paste-image exited 1: x",
        "paste-image",
        "exit",
        1,
        "The image URL is not valid. Nothing was pasted.\nTokiwa: The image was not pasted.\n",
      );
    },
  });
  try {
    s.cmdV();
    await pause();
    expect(s.written).toEqual([]);
    expect(s.footer()).toBe(
      "Image paste failed: The image URL is not valid. Nothing was pasted.",
    );
    expect(existsSync(s.files[0])).toBe(false);
  } finally {
    await s.t.dispose();
  }
});

test("a launcher sentence is shown without its prefix and without a second ending", async () => {
  const s = await setup({
    runner: async () => {
      throw new LauncherError(
        "Launcher paste-image exited 1: x",
        "paste-image",
        "exit",
        1,
        "Tokiwa: The image could not be uploaded. Nothing was pasted.\n",
      );
    },
  });
  try {
    s.cmdV();
    await pause();
    expect(s.written).toEqual([]);
    expect(s.footer()).toBe(
      "Image paste failed: The image could not be uploaded. Nothing was pasted.",
    );
  } finally {
    await s.t.dispose();
  }
});

test("a path that is not a PNG path on the host is never pasted", async () => {
  for (const path of ["relative.png", "/host/a b.png", "/host/x.txt", "/host/$(id).png", "/host/a\n.png"]) {
    const s = await setup({ runner: async () => JSON.stringify({ path }) });
    try {
      s.cmdV();
      await pause();
      expect(s.written).toEqual([]);
      expect(s.footer()).toBe(
        "Image paste failed: The host returned an invalid path. Nothing was pasted.",
      );
    } finally {
      await s.t.dispose();
    }
  }
});

test("the pasting notice lasts as long as the launcher timeout", async () => {
  let release: (v: string) => void = () => {};
  const s = await setup({ runner: () => new Promise<string>((r) => (release = r)) });
  try {
    s.cmdV();
    await pause();
    expect(s.footer()).toBe("Pasting image…");
    expect(s.app.footerNotice!.until - Date.now()).toBeGreaterThan(85000);
    release(JSON.stringify({ path: "/host/path.png" }));
    await pause();
  } finally {
    await s.t.dispose();
  }
});

test("a local view does nothing", async () => {
  const s = await setup({ remote: false });
  try {
    s.cmdV();
    await pause();
    expect(s.calls).toEqual([]);
    expect(s.files).toEqual([]);
    expect(s.written).toEqual([]);
  } finally {
    await s.t.dispose();
  }
});

test("no image on the clipboard does nothing and shows no notice", async () => {
  const s = await setup({ image: "none" });
  try {
    s.cmdV();
    await pause();
    expect(s.reads()).toBe(1);
    expect(s.calls).toEqual([]);
    expect(s.written).toEqual([]);
    expect(s.footer()).not.toContain("paste");
    expect(s.footer()).not.toContain("Pasting");
  } finally {
    await s.t.dispose();
  }
});

test("an image over 10 MB is refused", async () => {
  const s = await setup({ image: 10485761 });
  try {
    s.cmdV();
    await pause();
    expect(s.calls).toEqual([]);
    expect(s.footer()).toBe("The image is larger than 10 MB. Nothing was pasted.");
    expect(existsSync(s.files[0])).toBe(false);
  } finally {
    await s.t.dispose();
  }
});

test("a second Cmd+V while one runs makes no second call", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = await setup({
    runner: async () => {
      await gate;
      return JSON.stringify({ path: "/host/path.png" });
    },
  });
  try {
    s.cmdV();
    await pause();
    expect(s.footer()).toBe("Pasting image…");
    s.cmdV();
    await pause();
    expect(s.calls).toHaveLength(1);
    expect(s.footer()).toBe("An image paste is already in progress.");
    release();
    await pause();
    expect(s.written).toEqual([BRACKETED]);
  } finally {
    release();
    await s.t.dispose();
  }
});

test("a view that closes before the reply gets nothing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = await setup({
    runner: async () => {
      await gate;
      return JSON.stringify({ path: "/host/path.png" });
    },
  });
  try {
    s.cmdV();
    await pause();
    s.shell.exited = true;
    s.app.discardView(s.shell);
    release();
    await pause();
    expect(s.written).toEqual([]);
    expect(existsSync(s.files[0])).toBe(false);
  } finally {
    release();
    await s.t.dispose();
  }
});

test("with the palette open, Cmd+V does nothing", async () => {
  const s = await setup({});
  try {
    s.app.openPalette();
    s.cmdV();
    await pause();
    expect(s.calls).toEqual([]);
    expect(s.files).toEqual([]);
    expect(s.written).toEqual([]);
  } finally {
    await s.t.dispose();
  }
});

test("with the session list focused, Cmd+V does nothing", async () => {
  const s = await setup({});
  try {
    s.app.listFocused = true;
    expect(s.app.listHasFocus()).toBe(true);
    s.cmdV();
    await pause();
    expect(s.calls).toEqual([]);
    expect(s.files).toEqual([]);
    expect(s.written).toEqual([]);
  } finally {
    await s.t.dispose();
  }
});

test("in the health view, Cmd+V does nothing", async () => {
  const s = await setup({});
  try {
    s.app.show("health");
    s.cmdV();
    await pause();
    expect(s.calls).toEqual([]);
    expect(s.written).toEqual([]);
  } finally {
    await s.t.dispose();
  }
});

test("a view that closes mid-flight clears the pasting notice", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = await setup({
    runner: async () => {
      await gate;
      return JSON.stringify({ path: "/host/path.png" });
    },
  });
  try {
    s.cmdV();
    await pause();
    expect(s.footer()).toBe("Pasting image…");
    s.app.discardView(s.shell);
    release();
    await pause();
    expect(s.app.footerNotice).toBeUndefined();
  } finally {
    release();
    await s.t.dispose();
  }
});
