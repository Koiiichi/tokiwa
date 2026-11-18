import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export type Run = (cmd: string[]) => Promise<{ code: number; stdout: string }>;

const spawnRun: Run = async (cmd) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { code, stdout };
};

/**
 * The osascript arguments that write the clipboard as `kind` data to `file`. The path is a script
 * argument (`on run argv`), so that no character of it is read as AppleScript.
 */
function writeScript(kind: "PNGf" | "TIFF", file: string) {
  return [
    "osascript",
    "-e",
    "on run argv",
    "-e",
    "set f to open for access POSIX file (item 1 of argv) with write permission",
    "-e",
    `write (the clipboard as «class ${kind}») to f`,
    "-e",
    "close access f",
    "-e",
    "end run",
    file,
  ];
}

const hasData = (file: string) => existsSync(file) && statSync(file).size > 0;

/**
 * Writes the clipboard image as `dir/clipboard-<random>.png` and returns that path.
 * Returns undefined when the clipboard holds no image.
 */
export async function readClipboardImage(
  dir: string,
  run: Run = spawnRun,
): Promise<string | undefined> {
  const base = join(dir, `clipboard-${randomUUID()}`);
  const png = `${base}.png`;
  const tiff = `${base}.tiff`;
  try {
    const direct = await run(writeScript("PNGf", png));
    if (direct.code === 0 && hasData(png)) return png;
    rmSync(png, { force: true });
    const second = await run(writeScript("TIFF", tiff));
    if (second.code !== 0 || !hasData(tiff)) return undefined;
    const converted = await run(["sips", "-s", "format", "png", tiff, "--out", png]);
    if (converted.code !== 0 || !hasData(png))
      throw new Error("The clipboard image could not be read.");
    return png;
  } catch (e) {
    rmSync(png, { force: true });
    throw e;
  } finally {
    rmSync(tiff, { force: true });
  }
}
