/**
 * Turn the raw output of a failed launcher read into one problem: its cause, a short title in
 * plain words, and the raw lines for a person who wants them.
 */
import { SIGN_IN_EXPIRED } from "./backend";

export type ProblemKind = "signed-out" | "stopped" | "offline" | "failed";
export interface Problem {
  kind: ProblemKind;
  title: string;
  /** The raw output, one line each. */
  detail: string[];
}

/** A shell that starts in a removed folder prints these lines; they never name the cause. */
const NOISE = /error retrieving current directory: getcwd/;
const LAUNCHER = /^(Error: )?Launcher \S+ exited -?\d+:\s*/;
const SIGNED_OUT = new RegExp(
  `${SIGN_IN_EXPIRED.source}|Token has expired and refresh failed|The SSO session .* has expired`,
);
const STOPPED = /The host is (\S+?)\.? No restart was requested/;
const OFFLINE =
  /Could not connect to the endpoint URL|ENOTFOUND|getaddrinfo|Name or service not known|Network is unreachable/;
const NOT_READY = /The workbench check returned/;

/** The order in which one problem explains another: an expired sign-in explains every read. */
const RANK: ProblemKind[] = ["signed-out", "stopped", "offline", "failed"];

export function diagnose(raw: string): Problem {
  const detail = raw.split("\n").filter((line) => line.trim());
  const meaningful = raw
    .replace(LAUNCHER, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !NOISE.test(line));
  const stopped = raw.match(STOPPED);
  if (SIGNED_OUT.test(raw))
    return { kind: "signed-out", title: "AWS sign-in expired", detail };
  if (stopped)
    return {
      kind: "stopped",
      title: `The workstation is ${stopped[1]}`,
      detail,
    };
  if (OFFLINE.test(raw))
    return {
      kind: "offline",
      title: "AWS cannot be reached from this Mac",
      detail,
    };
  if (NOT_READY.test(raw))
    return {
      kind: "failed",
      title: "The workbench server is not ready",
      detail,
    };
  const first = (meaningful[0] ?? "").replace(/^(Error: )?(Tokiwa: )?/, "");
  return { kind: "failed", title: first || "The launcher failed", detail };
}

/** The problem that explains the others, or undefined when there is none. */
export function worst(problems: Problem[]): Problem | undefined {
  return [...problems].sort(
    (a, b) => RANK.indexOf(a.kind) - RANK.indexOf(b.kind),
  )[0];
}
