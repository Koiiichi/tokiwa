/**
 * Turn a failed launcher read into one Failure: its kind, a title in plain words, and the lines
 * for a person who wants them. `classify` is the only function that does this. It holds no AWS
 * CLI error pattern: the launcher reports AWS access failures as a category.
 */
import {
  LauncherError,
  SIGN_IN_EXPIRED,
  type LauncherCategory,
} from "./backend";
import type { SourceStatus } from "./state";

export type Source = "sessions" | "health" | "spend";
export type ProblemKind =
  "setup" | "signed-out" | "offline" | "stopped" | "not-ready" | "failed";
export interface Failure {
  source: Source;
  kind: ProblemKind;
  /** A short title without a trailing period. */
  title: string;
  summary: string;
  explanation: string;
  /** The launcher command that failed, or an empty string. */
  command: string;
  code: number | null;
  category?: LauncherCategory;
  /** The output of the failed read, one line each, without the launcher prefix or shell noise. */
  detail: string;
  /** The message as the launcher call raised it, for the error log. */
  raw: string;
  at: number;
}

/** The order in which one failure explains another. Only `failed` is a component failure. */
const RANK: ProblemKind[] = [
  "setup",
  "signed-out",
  "offline",
  "stopped",
  "not-ready",
  "failed",
];
/** Every kind that speaks for the whole link; a `failed` read stays with its own source. */
export const GLOBAL_KINDS: ProblemKind[] = RANK.filter((k) => k !== "failed");

/** The launcher sentences that `classify` maps. Each must exist in `bin/tokiwa`. */
export const MAPPED_SENTENCES = [
  "AWS authentication failed",
  "AWS login did not complete",
  "The host state could not be read",
  "The host check could not be submitted",
  "No restart was requested",
  "The workbench check returned",
  "Set the host in",
  "has a line that is not KEY=VALUE",
  "region= must be an AWS region",
  "The end time in",
  "has passed. No host was started",
  "The AWS account does not match account=",
];

/** A shell that starts in a removed folder prints these lines; they never name the cause. */
const NOISE = /error retrieving current directory: getcwd/;
const LAUNCHER = /^(Error: )?Launcher (\S+) exited (-?\d+):\s*/;
const STOPPED = /The host is (\S+?)\.? No restart was requested/;
const AWS_REQUEST_FAILED =
  /The host state could not be read|The host check could not be submitted/;
const NOT_READY = /The workbench check returned (\S+?)\.?(\s|$)/;
const SETTINGS = new RegExp(
  [
    "Set the host in",
    "has a line that is not KEY=VALUE",
    "region= must be an AWS region",
    "The end time in .* has passed",
    "The AWS account does not match account=",
  ].join("|"),
);
const LABEL: Record<Source, string> = {
  sessions: "Sessions",
  health: "Health",
  spend: "Spend",
};

function lower(text: string) {
  return /^[A-Z][a-z]/.test(text)
    ? text[0].toLowerCase() + text.slice(1)
    : text;
}

export function classify(source: Source, error: unknown, at: number): Failure {
  const launcher = error instanceof LauncherError ? error : undefined;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const prefix = LAUNCHER.exec(message);
  const command = launcher?.command ?? prefix?.[2] ?? "";
  const code = launcher ? launcher.code : prefix ? Number(prefix[3]) : null;
  const lines = message
    .replace(LAUNCHER, "")
    .replace(/^Error: /, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !NOISE.test(line));
  const detail = lines.join("\n");
  const made = (
    kind: ProblemKind,
    title: string,
    explanation: string,
    summary = title,
  ): Failure => ({
    source,
    kind,
    title,
    summary,
    explanation,
    command,
    code,
    ...(launcher?.category ? { category: launcher.category } : {}),
    detail,
    raw: message,
    at,
  });
  const signedOut = () =>
    made(
      "signed-out",
      "AWS sign-in expired",
      "The AWS sign-in on this Mac has expired. Sign in again to read the workstation.",
    );
  const offline = () =>
    made(
      "offline",
      "AWS cannot be reached from this Mac",
      "The request did not reach AWS. Check the network, then refresh and retry.",
    );

  if (launcher?.reason === "spawn")
    return made(
      "setup",
      "The launcher is not installed",
      "The app could not start the tokiwa launcher. Install it, then refresh and retry.",
    );
  if (launcher?.reason === "timeout") return offline();
  if (code === 2 && command)
    return made(
      "setup",
      "The launcher is older than the app",
      "The launcher does not know a command that this app sent. Update the launcher, then refresh and retry.",
    );
  if (launcher?.category === "auth") return signedOut();
  if (launcher?.category === "unreachable") return offline();

  const text = detail;
  const settings = lines.find((line) => SETTINGS.test(line));
  if (settings)
    return made(
      "setup",
      "The host settings need a fix",
      settings.replace(/^Tokiwa: /, ""),
    );
  // An older launcher gives no category; its sign-in sentence is all the app has.
  if (SIGN_IN_EXPIRED.test(text)) return signedOut();
  if (AWS_REQUEST_FAILED.test(text))
    return made(
      "offline",
      "An AWS request failed",
      "A request to AWS failed after the sign-in check passed. The workstation state is unknown. Refresh and retry.",
    );
  const stopped = STOPPED.exec(text);
  if (stopped)
    return made(
      "stopped",
      `The workstation is ${stopped[1]}`,
      `The workstation is ${stopped[1]}. The app does not start it.`,
    );
  const check = NOT_READY.exec(text);
  // Only Failed is a verdict. Any other status word comes from polls that did not finish.
  if (check && check[1] !== "Failed")
    return made(
      "offline",
      "An AWS request did not finish",
      "A request to AWS did not finish, so the workbench state is unknown. Refresh and retry.",
    );
  if (check)
    return made(
      "not-ready",
      "The workbench server is not ready",
      "The workstation runs, but its workbench check did not pass. Retry in a moment.",
    );
  const summary = (lines[0] ?? "")
    .replace(/^(Tokiwa: )?/, "")
    .replace(/\.$/, "");
  const label = `${LABEL[source]} read failed`;
  const failed = made(
    "failed",
    summary ? `${label}: ${lower(summary)}` : label,
    summary || "The launcher failed",
    summary || "The launcher failed",
  );
  return failed;
}

/** The failure that explains the others, or undefined when there is none. */
export function worst(failures: Failure[]): Failure | undefined {
  return [...failures].sort(
    (a, b) => RANK.indexOf(a.kind) - RANK.indexOf(b.kind),
  )[0];
}

const SOURCES: Source[] = ["sessions", "health", "spend"];

/** What every view, the header and the band read: one explanation and one way to recover. */
export interface ErrorState {
  kind: ProblemKind;
  scope: "global" | "component";
  /** The title of the failure, without a trailing period. */
  title: string;
  explanation: string;
  /** The sources that the failure keeps from being live. A global failure affects all of them. */
  affected: Source[];
  recovery: "sign-in" | "retry" | "none";
  /**
   * The kind of the worst active global failure that is not `setup`. The header word names it, so
   * connectivity shows first when a `setup` failure is active too.
   */
  link?: ProblemKind;
  /** When the newest good read among the affected sources ended, in milliseconds. */
  lastSuccess?: number;
  /** The active failure of each failed source, in the order sessions, health, spend. */
  diagnostics: Failure[];
}

/**
 * The failure to show, or undefined. A global failure is active while it is later than the newest
 * success of any source: one good read shows that the link works. `stopped` and `not-ready` are
 * workstation states, which a spend read does not disprove; only a session or Health read clears them. Of those, `worst` explains the
 * others. Without one, the newest failure of a source that failed for its own reason is active
 * until that source succeeds. A failed spend read stays in the Spend rows and is never chosen.
 * `now` is part of the call for a later rule; no rule reads it yet.
 */
export function errorState(
  sources: Record<Source, SourceStatus>,
  now: number,
): ErrorState | undefined {
  const newestOk = Math.max(...SOURCES.map((s) => sources[s].okAt));
  // A spend read succeeds on a stopped host, so only a session or Health read clears `stopped` and
  // `not-ready`. Any source clears the other global kinds.
  const newestRead = Math.max(sources.sessions.okAt, sources.health.okAt);
  const active = (f: Failure) =>
    f.at >
    (f.kind === "stopped" || f.kind === "not-ready" ? newestRead : newestOk);
  const failures = SOURCES.flatMap((s) => sources[s].failure ?? []);
  const global = failures.filter(
    (f) => GLOBAL_KINDS.includes(f.kind) && active(f),
  );
  const diagnostics = failures.filter(
    (f) => !GLOBAL_KINDS.includes(f.kind) || active(f),
  );
  const top = worst(global);
  const link = worst(global.filter((f) => f.kind !== "setup"));
  if (top)
    return {
      kind: top.kind,
      scope: "global",
      title: top.title,
      explanation: top.explanation,
      affected: [...SOURCES],
      recovery:
        top.kind === "signed-out"
          ? "sign-in"
          : top.kind === "setup"
            ? "none"
            : "retry",
      ...(link ? { link: link.kind } : {}),
      ...(newestOk > 0 ? { lastSuccess: newestOk } : {}),
      diagnostics,
    };
  const own = failures
    .filter((f) => f.kind === "failed" && f.source !== "spend")
    .sort((a, b) => b.at - a.at)[0];
  if (!own) return undefined;
  const okAt = sources[own.source].okAt;
  return {
    kind: own.kind,
    scope: "component",
    title: own.title,
    explanation: own.explanation,
    affected: [own.source],
    recovery: "retry",
    ...(okAt > 0 ? { lastSuccess: okAt } : {}),
    diagnostics,
  };
}
