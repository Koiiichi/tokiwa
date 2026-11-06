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
