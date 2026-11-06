import type { CliRenderer } from "@opentui/core";

/** How long a new row must hold still before the cursor moves to it. */
export const CURSOR_SETTLE_MS = 64;

/**
 * Keep the cursor off the rows that a redraw passes through. tmux draws with the cursor visible
 * and Session Manager carries the output in pieces, so a paint between two pieces finds the
 * cursor on whatever row tmux was drawing, not where the program rests it. Each such paint moved
 * the real cursor, which showed as a faint mark running down the view during a scroll.
 *
 * The cursor stays where it last rested until a new row has held still for `settleMs`. A move
 * along one row, as in typing, shows at once. This wraps the renderer method that the terminal
 * view calls on each paint.
 */
export function steadyCursor(
  renderer: Pick<CliRenderer, "setCursorPosition" | "requestRender"> & {
    isDestroyed: boolean;
  },
  settleMs = CURSOR_SETTLE_MS,
) {
  const place = renderer.setCursorPosition.bind(renderer);
  let rest: { x: number; y: number } | undefined;
  let next: { x: number; y: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    next = undefined;
  };
  renderer.setCursorPosition = (x, y, visible = true) => {
    if (!visible) {
      cancel();
      place(x, y, false);
      return;
    }
    if (!rest || y === rest.y) {
      cancel();
      rest = { x, y };
      place(x, y, true);
      return;
    }
    if (next?.y !== y) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (renderer.isDestroyed || !next) return;
        rest = next;
        next = undefined;
        place(rest.x, rest.y, true);
        renderer.requestRender();
      }, settleMs);
    }
    next = { x, y };
    place(rest.x, rest.y, true);
  };
}
