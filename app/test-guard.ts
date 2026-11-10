/**
 * Keep every test away from the installed launcher, which makes AWS calls. A test that needs the
 * backend gives BackendClient a runner or replaces a backend method.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { BackendClient } from "./backend";

// A fake launcher that a test writes into the temporary folder may run; the installed one is never there.
const temporary = realpathSync(tmpdir()) + "/";
function insideTemporary(path: string): boolean {
  try {
    return realpathSync(path).startsWith(temporary);
  } catch {
    return false;
  }
}
const call = BackendClient.prototype.call;
BackendClient.prototype.call = function (this: BackendClient, args: string[]) {
  if ((this as unknown as { runner?: unknown }).runner)
    return call.call(this, args);
  if (insideTemporary(this.launcher)) return call.call(this, args);
  return Promise.reject(
    new Error(
      `Tests do not run the launcher (${args[0]}). Give BackendClient a runner.`,
    ),
  );
};

// Keep every test away from the user's saved project order: each test run uses an empty one.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
process.env.TOKIWA_ORDER_FILE = join(
  mkdtempSync(join(tmpdir(), "tokiwa-test-")),
  "project-order.json",
);
// No test opens the user's browser: a link that a test opens runs /usr/bin/true instead.
process.env.TOKIWA_OPEN = "/usr/bin/true";
// A local shell in a test reads none of the user's startup files.
process.env.TOKIWA_LOCAL_SHELL = "/bin/zsh -f";
