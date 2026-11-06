import { test, expect } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("q ends the app while a launcher call is still running", async () => {
  const home = mkdtempSync(join(tmpdir(), "tokiwa-quit-"));
  const launcher = join(home, ".local/bin/tokiwa");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(
    launcher,
    `#!/bin/sh
case "$1" in
 --snapshot) echo '{"sessions":[],"projects":{}}' ;;
 *) sleep 40 ;;
esac
`,
  );
  chmodSync(launcher, 0o755);
  const app = Bun.spawn([process.execPath, join(import.meta.dir, "app.ts")], {
    cwd: import.meta.dir,
    env: { HOME: home, PATH: process.env.PATH ?? "", TERM: "xterm-256color" },
    terminal: { cols: 100, rows: 30, data() {} },
  });
  try {
    await Bun.sleep(2500);
    app.terminal!.write("q");
    const ended = await Promise.race([
      app.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    expect(ended).toBe(true);
  } finally {
    app.kill(9);
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);
