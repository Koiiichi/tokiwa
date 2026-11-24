/** The footer: one line of controls for the current context, and a message at its right. */

/** One footer hint. A hint with `run` is a control: it highlights under the pointer and runs on a click. */
export interface Hint {
  /** A stable name, for the highlight and the renderable id. */
  id: string;
  key: string;
  label: string;
  /** When the line is too long, the controls with the lowest rank go first. */
  rank: number;
  run?: () => void;
  /** The hint sits at the right end of the line, label first. */
  end?: boolean;
}
/**
 * `key-first` writes `enter attach`, for keys that act directly. `label-first` writes
 * `copy ctrl+shift+c`, for the chords that reach the app from inside a terminal.
 */
export type HintOrder = "key-first" | "label-first";
export const SEPARATOR = " · ";
/** The fewest cells between the controls and the message. */
export const MESSAGE_GAP = 2;

export const hint = (
  id: string,
  key: string,
  label: string,
  rank: number,
  run?: () => void,
): Hint => ({ id, key, label, rank, run });

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

/**
 * The forms of a notice, longest first. A routine notice can lose the detail after each separator.
 * `whole` keeps a failure, or a notice with controls, in one piece, because its reader must act on it.
 */
export function noticeForms(text: string, whole: boolean) {
  if (whole) return [text];
  const parts = text.split(SEPARATOR);
  return parts.map((_, i) => parts.slice(0, parts.length - i).join(SEPARATOR));
}

/** Keep the key labels, and drop the controls with the lowest rank until the line fits. */
function fitWithKeys(hints: Hint[], width: number, order: HintOrder) {
  const controls = hints.filter((h) => h.run);
  let list = controls.length ? controls : hints;
  while (list.length > 1 && lineLength(list, true, order) > width) {
    const lowest = list.reduce((a, b) => (b.rank < a.rank ? b : a));
    list = list.filter((h) => h !== lowest);
  }
  return { hints: list, keys: true };
}

/**
 * Fit the controls and a message, given the width of each form of the message, longest first.
 * `form` is the index of the form to draw, or -1 without a message. The message shortens before a
 * control moves. Then the least important controls give way. A message with no room beside the
 * controls takes the line (`takesLine`), or, when `optional`, is left out so that the controls stay.
 */
export function fitFooter(
  hints: Hint[],
  forms: number[],
  width: number,
  order: HintOrder,
  optional = false,
) {
  const base = fitHints(hints, width, order);
  if (!forms.length) return { ...base, form: -1, takesLine: false };
  // The separator before an end control is in the line length, unless that control is alone.
  const cellsWith = (list: Hint[], keys: boolean, message: number) =>
    lineLength(list, keys, order) +
    (list[0]?.end ? SEPARATOR.length : MESSAGE_GAP) +
    message;
  const form = forms.findIndex(
    (cells) => cellsWith(base.hints, base.keys, cells) <= width,
  );
  if (form >= 0) return { ...base, form, takesLine: false };
  const last = forms.length - 1;
  const room = width - MESSAGE_GAP - forms[last];
  const squeezed = fitWithKeys(hints, room, order);
  if (room > 0 && cellsWith(squeezed.hints, true, forms[last]) <= width)
    return { ...squeezed, form: last, takesLine: false };
  if (optional) return { ...base, form: -1, takesLine: false };
  const alone = forms.findIndex((cells) => cells <= width);
  return { ...base, form: alone >= 0 ? alone : last, takesLine: true };
}
