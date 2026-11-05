/** Cell-sized UI observations. These symbols do not describe agent intent. */

/** The track colour of Health bars. The output throb fades the accent toward it and back. */
const THROB_LOW = "#454850";
// Four frames of 320 ms: full accent, two steps toward the track colour, one step back.
const THROB_STEPS = [0, 0.3, 0.6, 0.3];

/**
 * The colour of the output glyph ◆ at time `now`: a pulse of `accent` that keeps the shape of
 * the glyph. Reduced motion keeps the accent colour.
 */
export function throbColor(accent: string, now = Date.now(), animate = true) {
  const step = animate ? THROB_STEPS[Math.floor(now / 320) % 4] : 0;
  if (!step) return accent;
  const channel = (hex: string, i: number) =>
    parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  return (
    "#" +
    [0, 1, 2]
      .map((i) =>
        Math.round(
          channel(accent, i) +
            (channel(THROB_LOW, i) - channel(accent, i)) * step,
        )
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
export function paneLayout(
  width: number,
  height: number,
): "side" | "stack" | "single" {
  if (width >= 110) return "side";
  if (width >= 76 && height >= 28) return "stack";
  return "single";
}
export const workspaceRoot = "/srv/development/state/workspaces";
export function projectPath(project: string, target = project) {
  if (
    !project.startsWith(workspaceRoot + "/") ||
    (target !== project && !target.startsWith(project + "/"))
  )
    throw new Error("The path is outside the selected project.");
  if (
    target.split("/").some((p) => p === ".." || p === ".") ||
    /[\x00-\x1f\x7f]/.test(target)
  )
    throw new Error("The project path is invalid.");
  return target.slice(workspaceRoot.length + 1);
}
export function safeText(text: string) {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "�");
}
export interface FileResult {
  path: string;
  entries?: { name: string; kind: "directory" | "file" | "link" | "special" }[];
  text?: string;
  truncated?: boolean;
  more?: boolean;
  offset?: number;
}
export function fileResult(value: unknown, path: string): FileResult {
  const r = value as FileResult;
  if (!r || r.path !== path) throw new Error("The file response path changed.");
  if (typeof r.text === "string" && r.text.length <= 12000)
    return { ...r, text: safeText(r.text) };
  if (
    !Array.isArray(r.entries) ||
    r.entries.length > 40 ||
    !r.entries.every(
      (e) =>
        typeof e.name === "string" &&
        e.name.length <= 255 &&
        e.name !== "." &&
        e.name !== ".." &&
        !/[\x00-\x1f\x7f/]/.test(e.name) &&
        ["directory", "file", "link", "special"].includes(e.kind),
    )
  )
    throw new Error("The file response is invalid.");
  return r;
}
