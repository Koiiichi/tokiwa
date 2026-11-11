import { test, expect } from "bun:test";
import { diagnose, worst } from "./problem";

const NOISE =
  "shell-init: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory\n" +
  "chdir: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory\n";

test("an expired AWS sign-in is named in plain words, without the shell noise before it", () => {
  const p = diagnose(
    "Error: Launcher health exited 1: " +
      NOISE +
      "Tokiwa: AWS authentication failed. Run aws sso login --profile work.",
  );
  expect(p.kind).toBe("signed-out");
  expect(p.title).toBe("AWS sign-in expired");
  // The details keep the raw output for a person who wants it.
  expect(p.detail.join("\n")).toContain("getcwd");
  expect(
    diagnose(
      "Error when retrieving token from sso: Token has expired and refresh failed",
    ).kind,
  ).toBe("signed-out");
  expect(
    diagnose(
      "Tokiwa: The AWS login did not complete. Run aws sso login --profile work.",
    ).kind,
  ).toBe("signed-out");
});

test("a stopped workstation, a missing network and a server that is not ready each have a cause", () => {
  expect(
    diagnose("Tokiwa: The host is stopped. No restart was requested."),
  ).toMatchObject({
    kind: "stopped",
    title: "The workstation is stopped",
  });
  expect(
    diagnose(
      'Could not connect to the endpoint URL: "https://ec2.us-east-1.amazonaws.com/"',
    ),
  ).toMatchObject({
    kind: "offline",
    title: "AWS cannot be reached from this Mac",
  });
  expect(
    diagnose(
      "Tokiwa: The workbench check returned failed. No service was started.",
    ),
  ).toMatchObject({
    kind: "failed",
    title: "The workbench server is not ready",
  });
});

test("an unknown failure shows its first meaningful line, without the launcher prefix", () => {
  const p = diagnose(
    "Error: Launcher --snapshot exited 255: " +
      NOISE +
      "ssh: unexpected reply\nmore",
  );
  expect(p.kind).toBe("failed");
  expect(p.title).toBe("ssh: unexpected reply");
  expect(diagnose("Launcher --snapshot exited 1:").title).toBe(
    "The launcher failed",
  );
  expect(diagnose("Error: offline").title).toBe("offline");
});

test("the sign-in explains every other failure, so it wins; the others keep their order", () => {
  const signedOut = diagnose("Tokiwa: AWS authentication failed.");
  const failed = diagnose("ssh: unexpected reply");
  const offline = diagnose("Could not connect to the endpoint URL");
  expect(worst([failed, signedOut])).toBe(signedOut);
  expect(worst([failed, offline])).toBe(offline);
  expect(worst([])).toBeUndefined();
});
