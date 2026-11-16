import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { LauncherError, type LauncherCategory } from "./backend";
import {
  MAPPED_SENTENCES,
  classify,
  errorState,
  worst,
  GLOBAL_KINDS,
  type Source,
} from "./problem";
import { FRESHNESS_LIMIT_MS, SourceStatus } from "./state";

const NOISE =
  "shell-init: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory\n" +
  "chdir: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory\n";

function exit(
  stderr: string,
  opts: { code?: number; category?: LauncherCategory; command?: string } = {},
) {
  const command = opts.command ?? "--snapshot";
  const code = opts.code ?? 1;
  return new LauncherError(
    `Launcher ${command} exited ${code}: ${stderr}`,
    command,
    "exit",
    code,
    stderr,
    opts.category,
  );
}
const plain = (message: string) => new Error(message);
const read = (error: unknown) => classify("sessions", error, 1);

test("a category from the launcher decides the kind, whatever the text says", () => {
  const text =
    "Tokiwa: AWS authentication failed. Run aws sso login --profile profile-a.";
  expect(read(exit(text, { category: "unreachable" }))).toMatchObject({
    kind: "offline",
    title: "AWS cannot be reached from this Mac",
    category: "unreachable",
  });
  expect(read(exit(text, { category: "auth" }))).toMatchObject({
    kind: "signed-out",
    title: "AWS sign-in expired",
  });
});

test("an older launcher's sign-in sentence still means signed-out", () => {
  const f = read(
    plain(
      "Launcher --snapshot exited 1: Tokiwa: AWS authentication failed. Run aws sso login --profile profile-a.",
    ),
  );
  expect(f.kind).toBe("signed-out");
  expect(f.command).toBe("--snapshot");
  expect(f.code).toBe(1);
});

test("AWS CLI text without a category is a component failure", () => {
  expect(
    read(
      plain("Launcher health exited 1: Could not connect to the endpoint URL"),
    ).kind,
  ).toBe("failed");
  expect(
    read(plain("Launcher health exited 1: getaddrinfo ENOTFOUND host")).kind,
  ).toBe("failed");
});

test("a later AWS read failure is offline, not a workstation state", () => {
  for (const sentence of [
    "Tokiwa: The host state could not be read.",
    "Tokiwa: The host check could not be submitted.",
  ])
    expect(read(exit(sentence))).toMatchObject({
      kind: "offline",
      title: "An AWS request failed",
    });
});

test("a timeout is offline; a spawn failure and exit 2 are setup", () => {
  expect(
    read(
      new LauncherError(
        "The launcher exceeded 90 seconds.",
        "health",
        "timeout",
        null,
        "",
      ),
    ),
  ).toMatchObject({ kind: "offline" });
  expect(
    read(
      new LauncherError(
        "Launcher health could not start: x",
        "health",
        "spawn",
        null,
        "x",
      ),
    ),
  ).toMatchObject({ kind: "setup", title: "The launcher is not installed" });
  expect(read(exit("usage: tokiwa", { code: 2 }))).toMatchObject({
    kind: "setup",
    title: "The launcher is older than the app",
  });
});

test("the host, workbench and settings sentences each have a kind", () => {
  expect(
    read(exit("Tokiwa: The host is stopped. No restart was requested.")),
  ).toMatchObject({ kind: "stopped", title: "The workstation is stopped" });
  expect(
    read(
      exit(
        "Tokiwa: The workbench check returned Failed. No service was started.",
      ),
    ).kind,
  ).toBe("not-ready");
  for (const sentence of [
    "Set the host in /home/user/.config/tokiwa/host.conf: instance=, profile= and region=.",
    "/home/user/.config/tokiwa/host.conf has a line that is not KEY=VALUE for instance, profile, region, account or end.",
    "/home/user/.config/tokiwa/host.conf: region= must be an AWS region, for example us-east-1.",
    "The end time in /home/user/.config/tokiwa/host.conf has passed. No host was started.",
    "The AWS account does not match account= in /home/user/.config/tokiwa/host.conf.",
  ]) {
    const f = read(exit(`Tokiwa: ${sentence}`));
    expect(f.kind).toBe("setup");
    expect(f.title).toBe("The host settings need a fix");
    expect(f.explanation).toBe(`Tokiwa: ${sentence}`.replace(/^Tokiwa: /, ""));
  }
});

test("titles carry no trailing period, no launcher prefix and no shell noise", () => {
  const f = read(
    plain(
      "Error: Launcher --snapshot exited 255: " +
        NOISE +
        "ssh: unexpected reply",
    ),
  );
  expect(f.kind).toBe("failed");
  expect(f.summary).toBe("ssh: unexpected reply");
  expect(f.title).toBe("Sessions read failed: ssh: unexpected reply");
  expect(f.detail).not.toContain("Launcher");
  expect(f.detail).not.toContain("getcwd");
  expect(read(plain("Launcher --snapshot exited 1:")).summary).toBe(
    "The launcher failed",
  );
  expect(classify("health", "Tokiwa: Bad thing happened.", 1).title).toBe(
    "Health read failed: bad thing happened",
  );
});

test("worst ranks setup, signed-out, offline, stopped, not-ready, failed", () => {
  const kinds = [
    ["failed", "ssh: unexpected reply"],
    ["not-ready", "The workbench check returned Failed."],
    ["stopped", "The host is stopped. No restart was requested."],
    ["offline", "The host state could not be read."],
    ["signed-out", "AWS authentication failed."],
    ["setup", "Set the host in x: instance="],
  ] as const;
  const all = kinds.map(([kind, text]) => {
    const f = read(plain(text));
    expect(f.kind).toBe(kind);
    return f;
  });
  for (let i = all.length - 1; i > 0; i--)
    expect(worst(all.slice(0, i + 1))).toBe(all[i]);
  expect(worst([])).toBeUndefined();
  expect(GLOBAL_KINDS).not.toContain("failed");
  expect(GLOBAL_KINDS).toHaveLength(5);
});

test("each sentence that classify maps exists in bin/tokiwa", () => {
  const launcher = readFileSync("../bin/tokiwa", "utf8");
  for (const sentence of MAPPED_SENTENCES) expect(launcher).toContain(sentence);
});

test("only a Failed workbench check is a verdict; any other status is an unfinished AWS request", () => {
  for (const status of [
    "Pending",
    "InProgress",
    "Delayed",
    "TimedOut",
    "Cancelled",
  ])
    expect(
      read(
        exit(
          `Tokiwa: The workbench check returned ${status}. No service was started.`,
        ),
      ),
    ).toMatchObject({
      kind: "offline",
      title: "An AWS request did not finish",
    });
  expect(
    read(
      exit(
        "Tokiwa: The workbench check returned Failed. No service was started.",
      ),
    ).kind,
  ).toBe("not-ready");
});

test("a failure keeps its raw message", () => {
  expect(read(exit("x", { code: 255 })).raw).toBe(
    "Launcher --snapshot exited 255: x",
  );
});

function statuses() {
  const make = (source: Source) => new SourceStatus(FRESHNESS_LIMIT_MS[source]);
  return {
    sessions: make("sessions"),
    health: make("health"),
    spend: make("spend"),
  };
}

test("one success clears a global failure for all sources", () => {
  const sources = statuses();
  sources.health.fail(
    classify(
      "health",
      exit("Tokiwa: AWS authentication failed.", { category: "auth" }),
      10,
    ),
  );
  expect(errorState(sources, 15)?.kind).toBe("signed-out");
  sources.sessions.succeed(20);
  // Health's own failure is newer than its own success, yet the link works.
  expect(sources.health.failAt).toBeGreaterThan(sources.health.okAt);
  expect(errorState(sources, 25)).toBeUndefined();
});

test("a component failure stays until its own source succeeds", () => {
  const sources = statuses();
  sources.health.fail(
    classify("health", plain("The health response is invalid."), 10),
  );
  sources.sessions.succeed(20);
  expect(errorState(sources, 25)).toMatchObject({
    kind: "failed",
    scope: "component",
    affected: ["health"],
    recovery: "retry",
  });
  expect(errorState(sources, 25)?.lastSuccess).toBeUndefined();
  sources.health.succeed(30);
  expect(errorState(sources, 35)).toBeUndefined();
});

test("a global failure names every source, ranks by cause and keeps each diagnostic", () => {
  const sources = statuses();
  sources.spend.succeed(5);
  sources.sessions.fail(
    classify(
      "sessions",
      exit("Tokiwa: AWS authentication failed.", { category: "auth" }),
      10,
    ),
  );
  sources.health.fail(
    classify(
      "health",
      exit("x", { category: "unreachable", command: "health" }),
      11,
    ),
  );
  const state = errorState(sources, 12)!;
  expect(state).toMatchObject({
    kind: "signed-out",
    scope: "global",
    title: "AWS sign-in expired",
    affected: ["sessions", "health", "spend"],
    recovery: "sign-in",
    lastSuccess: 5,
  });
  expect(state.diagnostics.map((f) => f.source)).toEqual([
    "sessions",
    "health",
  ]);
});

test("a setup failure offers no recovery key, and a spend failure is not a component error", () => {
  const sources = statuses();
  sources.spend.fail(
    classify("spend", plain("The spend response is invalid."), 10),
  );
  expect(errorState(sources, 11)).toBeUndefined();
  sources.sessions.fail(
    classify(
      "sessions",
      new LauncherError(
        "Launcher --snapshot could not start: x",
        "--snapshot",
        "spawn",
        null,
        "x",
      ),
      12,
    ),
  );
  expect(errorState(sources, 13)).toMatchObject({
    kind: "setup",
    recovery: "none",
  });
});
