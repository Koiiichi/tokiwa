/** The footer: one line of controls for the current context. */

/** One footer hint. A hint with `run` is a control: it highlights under the pointer and runs on a click. */
export interface Hint {
  /** A stable name, for the highlight and the renderable id. */
  id: string;
  key: string;
  label: string;
  /** When the line is too long, the controls with the lowest rank go first. */
  rank: number;
  run?: () => void;
}
/**
 * `key-first` writes `enter attach`, for keys that act directly. `label-first` writes
 * `copy ctrl+shift+c`, for the chords that reach the app from inside a terminal.
 */
export type HintOrder = "key-first" | "label-first";
export const SEPARATOR = " · ";

export function hintText(hint: Hint, keys: boolean, order: HintOrder) {
  if (!keys || !hint.key) return hint.label;
  return order === "key-first"
    ? `${hint.key} ${hint.label}`
    : `${hint.label} ${hint.key}`;
}

export function lineLength(hints: Hint[], keys: boolean, order: HintOrder) {
  return hints.reduce(
    (n, h, i) =>
      n + (i ? SEPARATOR.length : 0) + hintText(h, keys, order).length,
    0,
  );
}

/**
 * Fit the hints into `width` cells. When the line is too long, the hints that are not controls
 * go first, then the key labels, then the controls with the lowest rank. One control stays.
 */
export function fitHints(hints: Hint[], width: number, order: HintOrder) {
  if (lineLength(hints, true, order) <= width) return { hints, keys: true };
  const controls = hints.filter((h) => h.run);
  let list = controls.length ? controls : hints;
  if (lineLength(list, true, order) <= width)
    return { hints: list, keys: true };
  while (list.length > 1 && lineLength(list, false, order) > width) {
    const lowest = list.reduce((a, b) => (b.rank < a.rank ? b : a));
    list = list.filter((h) => h !== lowest);
  }
  return { hints: list, keys: false };
}
