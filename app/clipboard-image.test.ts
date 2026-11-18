import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClipboardImage } from "./clipboard-image";

const target = (cmd: string[]) => cmd[cmd.length - 1];
const kindOf = (cmd: string[]) => cmd.join(" ");
const dir = () => mkdtempSync(join(tmpdir(), "clip-test-"));

test("a PNG on the clipboard returns a .png path", async () => {
  const d = dir();
  try {
    const path = await readClipboardImage(d, async (cmd) => {
      if (cmd[0] === "osascript" && kindOf(cmd).includes("PNGf")) {
        writeFileSync(target(cmd), "png");
        return { code: 0, stdout: "" };
      }
      return { code: 1, stdout: "" };
    });
    expect(path).toMatch(/\.png$/);
    expect(existsSync(path!)).toBe(true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("only TIFF runs sips and returns a .png path, and removes the TIFF", async () => {
  const d = dir();
  const calls: string[][] = [];
  let tiff = "";
  try {
    const path = await readClipboardImage(d, async (cmd) => {
      calls.push(cmd);
      if (cmd[0] === "osascript" && kindOf(cmd).includes("PNGf"))
        return { code: 1, stdout: "" };
      if (cmd[0] === "osascript") {
        tiff = target(cmd);
        writeFileSync(tiff, "tiff");
        return { code: 0, stdout: "" };
      }
      expect(cmd.slice(0, 4)).toEqual(["sips", "-s", "format", "png"]);
      writeFileSync(cmd[cmd.indexOf("--out") + 1], "png");
      return { code: 0, stdout: "" };
    });
    expect(path).toMatch(/\.png$/);
    expect(calls.some((c) => c[0] === "sips")).toBe(true);
    expect(existsSync(tiff)).toBe(false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("no image returns undefined", async () => {
  const d = dir();
  try {
    expect(
      await readClipboardImage(d, async () => ({ code: 1, stdout: "" })),
    ).toBeUndefined();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a failed sips throws", async () => {
  const d = dir();
  try {
    await expect(
      readClipboardImage(d, async (cmd) => {
        if (cmd[0] === "osascript" && kindOf(cmd).includes("PNGf"))
          return { code: 1, stdout: "" };
        if (cmd[0] === "osascript") {
          writeFileSync(target(cmd), "tiff");
          return { code: 0, stdout: "" };
        }
        return { code: 1, stdout: "" };
      }),
    ).rejects.toThrow("The clipboard image could not be read.");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("the file path is a script argument, never part of the script", async () => {
  const d = dir();
  const seen: string[][] = [];
  try {
    await readClipboardImage(d, async (cmd) => {
      seen.push(cmd);
      return { code: 1, stdout: "" };
    });
    expect(seen.length).toBe(2);
    for (const cmd of seen) {
      const file = cmd[cmd.length - 1];
      expect(file.startsWith(d)).toBe(true);
      expect(cmd.slice(0, -1).some((part) => part.includes(file))).toBe(false);
      expect(cmd.slice(0, 4)).toEqual(["osascript", "-e", "on run argv", "-e"]);
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
