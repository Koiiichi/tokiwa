/** Open only the prepared remote launcher command. Never substitute a local shell. */
export function shellQuote(value: string) {
  if (value.includes("\0"))
    throw new Error("The command contains a null byte.");
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export async function openGhosttyWindow(command: string[]) {
  if (process.platform !== "darwin")
    throw new Error("Ghostty window launch is available on macOS only.");
  const script = `on run argv
    tell application "Ghostty"
      set c to new surface configuration
      set command of c to item 1 of argv
      set w to new window with configuration c
      return id of focused terminal of selected tab of w
    end tell
  end run`;
  const child = Bun.spawn(
    ["/usr/bin/osascript", "-e", script, command.map(shellQuote).join(" ")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timeout = setTimeout(() => child.kill(), 15000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(
        `Ghostty could not open the remote shell: ${err.trim().slice(0, 300)}`,
      );
    return out.trim();
  } finally {
    clearTimeout(timeout);
  }
}
