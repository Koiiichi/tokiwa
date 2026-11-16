import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const launcher = join(import.meta.dir, "..", "bin", "tokiwa");

// A fake aws that fails every sts call with FAKE_AWS_STDERR and records a sign-in in marker.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tokiwa-launcher-"));
  // The launcher sets its own PATH and looks in $HOME/.local/lib/cloud-access first.
  const bin = join(dir, ".local", "lib", "cloud-access");
  mkdirSync(bin, { recursive: true });
  const marker = join(dir, "marker");
  writeFileSync(
    join(bin, "aws"),
    `#!/bin/bash
case " $* " in
  *" sso "*) echo sso-login > "${marker}"; exit 1 ;;
  *" sts "*) printf '%s\\n' "$FAKE_AWS_STDERR" >&2; exit 255 ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, "aws"), 0o755);
  const config = join(dir, "host.env");
  writeFileSync(config, "instance=i-0123456789abcdef0\nprofile=profile-a\nregion=us-east-1\n");
  return { dir, bin, marker, config };
}

async function run(stderr: string, env: Record<string, string> = {}) {
  const s = setup();
  const proc = Bun.spawn(["bash", launcher, "health"], {
    env: {
      HOME: s.dir,
      PATH: `${s.bin}:/usr/bin:/bin`,
      TOKIWA_HOST_CONFIG: s.config,
      TOKIWA_DASHBOARD: "1",
      FAKE_AWS_STDERR: stderr,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

const unreachableText = [
  'Could not connect to the endpoint URL: "https://sts.us-east-1.amazonaws.com/"',
  'Connect timeout on endpoint URL: "https://sts.us-east-1.amazonaws.com/"',
  'Read timeout on endpoint URL: "https://sts.us-east-1.amazonaws.com/"',
  "Connection was closed before we received a valid response from endpoint URL",
];
const authMessage = "Tokiwa: AWS authentication failed. Run aws sso login --profile profile-a.";

test("a connection failure is unreachable", async () => {
  for (const text of unreachableText) {
    const r = await run(text);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Tokiwa: AWS cannot be reached from this Mac. Check the network, then retry.");
    expect(r.err).not.toContain("authentication");
  }
});

test("an expired token is auth", async () => {
  const r = await run("Error when retrieving token from sso: Token has expired and refresh failed");
  expect(r.code).toBe(1);
  expect(r.err).toContain(authMessage);
});

test("any other failure is auth, as before", async () => {
  const r = await run("An error occurred (AccessDenied)");
  expect(r.code).toBe(1);
  expect(r.err).toContain(authMessage);
});

test("the category line appears only on request", async () => {
  const last = (e: string) => e.trimEnd().split("\n").at(-1);
  const u = await run(unreachableText[0], { TOKIWA_ERROR_CATEGORY: "1" });
  expect(last(u.err)).toBe("tokiwa-error: unreachable");
  const a = await run("Token has expired and refresh failed", { TOKIWA_ERROR_CATEGORY: "1" });
  expect(last(a.err)).toBe("tokiwa-error: auth");
  for (const r of [await run(unreachableText[0]), await run("Token has expired")])
    expect(r.err.split("\n").some((l) => l.startsWith("tokiwa-error"))).toBe(false);
});

test("an unreachable result does not start a sign-in in a terminal", async () => {
  const s = setup();
  const proc = Bun.spawn(["script", "-q", "/dev/null", "bash", launcher, "health"], {
    env: {
      HOME: s.dir,
      PATH: `${s.bin}:/usr/bin:/bin`,
      TOKIWA_HOST_CONFIG: s.config,
      FAKE_AWS_STDERR: unreachableText[0],
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out).toContain("Tokiwa: AWS cannot be reached from this Mac. Check the network, then retry.");
  expect(existsSync(s.marker)).toBe(false);
});
