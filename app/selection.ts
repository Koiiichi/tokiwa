import type { CliRenderer, Renderable } from "@opentui/core";

/**
 * Keep a text selection that starts on a confined renderable, for example a session name, inside
 * that renderable. A press that moves the pointer by at most one cell is a click and selects no
 * text. Selections that start anywhere else, for example in a terminal, are unchanged.
 *
 * OpenTUI starts a selection on every left press over a selectable renderable, before the press
 * reaches its handler, and widens the selection to the parent containers when the pointer leaves
 * the renderable. This wraps the two renderer methods that start and move a selection.
 */
export function confineSelection(
  renderer: CliRenderer,
  confined: (renderable: Renderable) => boolean,
) {
  let scope: Renderable | undefined;
  let origin = { x: 0, y: 0 };
  const start = renderer.startSelection.bind(renderer);
  renderer.startSelection = (renderable, x, y, behavior) => {
    scope = confined(renderable) ? renderable : undefined;
    origin = { x, y };
    start(renderable, x, y, behavior);
  };
  const update = renderer.updateSelection.bind(renderer);
  renderer.updateSelection = (target, x, y, options) => {
    if (!scope) return update(target, x, y, options);
    // A redraw replaced the renderable under the selection: drop the selection.
    if (scope.isDestroyed) {
      scope = undefined;
      renderer.clearSelection();
      return;
    }
    if (Math.abs(x - origin.x) <= 1 && Math.abs(y - origin.y) <= 1) {
      x = origin.x;
      y = origin.y;
    } else {
      const left = Math.trunc(scope.x);
      x = Math.max(left, Math.min(left + scope.width - 1, x));
      y = Math.trunc(scope.y);
    }
    update(scope, x, y, options);
  };
}
