/**
 * The reference tables in docs/ copy facts from the code: the key map, the quick keys, the
 * environment variables, the options of run and the keys of health.json. These tests fail when a
 * table and the code disagree, so that a change to one updates the other in the same commit.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, HEALTH_KEYS, parseHealthConfig } from "./health-view";
import { KEYMAP, QUICK_KEYS, type Group } from "./shortcuts";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** The rows of the first table after a heading, as arrays of trimmed cells. */
function table(doc: string, heading: string): string[][] {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) throw new Error(`No heading "${heading}"`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(line)) break;
    if (!line.startsWith("|")) {
      if (rows.length) break;
      continue;
    }
    rows.push(line.split("|").slice(1, -1).map((c) => c.trim()));
  }
  // Drop the header row and the --- row.
  return rows.slice(2);
}
/** A key as the code writes it and as a table cell writes it, without spaces or backticks. */
const plain = (key: string) => key.replace(/[`\s]/g, "");

test("the key tables of docs/interface.md match the key map", () => {
  const doc = read("docs/interface.md");
  const groups: Group[] = ["Workspace", "Session", "Terminal", "Health", "Files"];
  for (const group of groups) {
    const rows = table(doc, `### ${group}`);
    const bindings = KEYMAP.filter((b) => b.group === group);
    expect({ group, keys: rows.map((r) => plain(r[0])) }).toEqual({
      group,
      keys: bindings.map((b) => plain(b.key)),
    });
    for (const [i, b] of bindings.entries())
      expect({ key: b.key, action: rows[i][1] }).toEqual({
        key: b.key,
        action: expect.stringContaining(`**${b.label}**`),
      });
  }
});

test("the quick key table of docs/interface.md matches the quick keys", () => {
  const rows = table(read("docs/interface.md"), "### Quick keys");
  expect(rows.map((r) => [plain(r[0]), r[1].toLowerCase()])).toEqual(
    QUICK_KEYS.map((q) => [q.key, q.label]),
  );
});

test("docs/configuration.md lists each TOKIWA_ variable that the app or the launcher reads", () => {
  const sources = [
    ...new Bun.Glob("*.ts").scanSync(import.meta.dir),
  ]
    .filter((f) => !f.endsWith(".test.ts") && f !== "test-guard.ts")
    .map((f) => `app/${f}`)
    .concat(["app/run", "app/install.sh", "bin/tokiwa"]);
  // A read in TypeScript (`process.env.X`, or `env.X` on an environment passed in) or in a shell
  // script (`${X`).
  const read_ = /\benv\.(TOKIWA_\w+)|process\.env\["(TOKIWA_\w+)"\]|\$\{(TOKIWA_\w+)/g;
  const used = new Set<string>();
  for (const file of sources)
    for (const m of read(file).matchAll(read_)) used.add(m[1] ?? m[2] ?? m[3]);
  const listed = table(read("docs/configuration.md"), "## Environment variables")
    .map((r) => r[0].replace(/`/g, ""))
    .filter((v) => v.startsWith("TOKIWA_"));
  expect(listed.sort()).toEqual([...used].sort());
});

test("docs/configuration.md lists each option of run", () => {
  const app = read("app/app.ts");
  const body = app.slice(app.indexOf("export function runOptions"));
  const parsed = new Set(
    [...body.slice(0, body.indexOf("\n}\n")).matchAll(/value\("(--[a-z-]+)"\)/g)].map(
      (m) => m[1],
    ),
  );
  const listed = new Set(
    table(read("docs/configuration.md"), "## Command-line options").map(
      (r) => r[0].replace(/`/g, "").split(" ")[0],
    ),
  );
  expect([...listed].sort()).toEqual([...parsed].sort());
});

test("the health.json table of docs/health.md lists each key that the app accepts", () => {
  const listed = table(read("docs/health.md"), "## health.json").map((r) =>
    r[0].replace(/`/g, ""),
  );
  const top = HEALTH_KEYS.filter((k) => k !== "prices");
  const keys = [
    ...top,
    ...Object.keys(DEFAULT_CONFIG.prices).map((k) => `prices.${k}`),
  ];
  expect(listed.sort()).toEqual(keys.sort());
  // Each listed top-level key is one that health.json accepts, not an unknown key.
  for (const key of top) {
    let error = "";
    try {
      parseHealthConfig({ [key]: null });
    } catch (e) {
      error = String(e);
    }
    expect(error).not.toContain("unknown key");
  }
});
