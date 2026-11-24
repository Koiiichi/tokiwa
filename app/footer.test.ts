import { test, expect } from "bun:test";
import {
  fitFooter,
  fitHints,
  hintText,
  lineLength,
  MESSAGE_GAP,
  noticeForms,
  SEPARATOR,
  type Hint,
  type HintOrder,
} from "./footer";

const run = () => {};
const terminal: Hint[] = [
  { id: "detach", key: "ctrl+k d", label: "detach", rank: 6, run },
  { id: "focus", key: "ctrl+k z", label: "focus", rank: 2, run },
  { id: "sessions", key: "ctrl+k w", label: "sessions", rank: 5, run },
  { id: "copy", key: "ctrl+shift+c", label: "copy", rank: 4, run },
  { id: "shortcuts", key: "ctrl+k ?", label: "shortcuts", rank: 9, run },
];
const line = (
  width: number,
  hints = terminal,
  order: HintOrder = "label-first",
) => {
  const fit = fitHints(hints, width, order);
  return fit.hints.map((h) => hintText(h, fit.keys, order)).join(SEPARATOR);
};

test("the footer drops the key labels first, then the least important controls", () => {
  expect(line(120)).toBe(
    "detach ctrl+k d · focus ctrl+k z · sessions ctrl+k w · copy ctrl+shift+c · shortcuts ctrl+k ?",
  );
  expect(line(60)).toBe("detach · focus · sessions · copy · shortcuts");
  expect(line(36)).toBe("detach · sessions · copy · shortcuts");
  expect(line(10)).toBe("shortcuts");
});

test("hints that are not controls go before the key labels", () => {
  const list: Hint[] = [
    { id: "select", key: "↑↓", label: "select", rank: 1 },
    { id: "attach", key: "enter", label: "attach", rank: 5, run },
    { id: "shortcuts", key: "?", label: "shortcuts", rank: 9, run },
  ];
  expect(line(80, list, "key-first")).toBe(
    "↑↓ select · enter attach · ? shortcuts",
  );
  const fit = fitHints(list, 30, "key-first");
  expect(fit.hints.map((h) => h.id)).toEqual(["attach", "shortcuts"]);
  expect(fit.keys).toBe(true);
});

const list: Hint[] = [
  { id: "select", key: "↑↓", label: "select", rank: 1 },
  { id: "attach", key: "enter", label: "attach", rank: 5, run },
  { id: "terminal", key: "esc", label: "terminal", rank: 4, run },
  { id: "focus", key: "z", label: "focus", rank: 2, run },
  { id: "shortcuts", key: "?", label: "shortcuts", rank: 9, run },
  { id: "quit", key: "q", label: "quit", rank: 8.5, run },
];
const ids = (fit: { hints: Hint[] }) => fit.hints.map((h) => h.id);

test("a routine notice loses its detail first, and a failure stays whole", () => {
  expect(noticeForms("detached web · it keeps running", false)).toEqual([
    "detached web · it keeps running",
    "detached web",
  ]);
  expect(noticeForms("copy failed · the terminal refused", true)).toEqual([
    "copy failed · the terminal refused",
  ]);
});

test("a message that fits beside the controls leaves them as they are", () => {
  const forms = noticeForms("detached web · it keeps running", false).map(
    (f) => f.length,
  );
  const fit = fitFooter(list, forms, 120, "key-first");
  expect(ids(fit)).toEqual(ids({ hints: list }));
  expect(fit.keys).toBe(true);
  expect(fit.form).toBe(0);
  expect(fit.takesLine).toBe(false);
});

test("a tight line shortens the message before it moves a control", () => {
  const forms = noticeForms("detached web · it keeps running", false).map(
    (f) => f.length,
  );
  const width = lineLength(list, true, "key-first") + MESSAGE_GAP + forms[1];
  const fit = fitFooter(list, forms, width, "key-first");
  expect(ids(fit)).toEqual(ids({ hints: list }));
  expect(fit.form).toBe(1);
});

test("a narrow line drops the least important controls and keeps quit and its key", () => {
  const fit = fitFooter(list, ["detached web".length], 52, "key-first");
  expect(ids(fit)).toEqual(["attach", "shortcuts", "quit"]);
  expect(fit.keys).toBe(true);
  expect(fit.takesLine).toBe(false);
  expect(
    lineLength(fit.hints, fit.keys, "key-first") +
      MESSAGE_GAP +
      "detached web".length,
  ).toBeLessThanOrEqual(52);
});

test("a message too long for any control beside it takes the line", () => {
  const fit = fitFooter(list, [40], 44, "key-first");
  expect(fit.takesLine).toBe(true);
  expect(fit.form).toBe(0);
});

test("an optional message with no room is left out, and the controls stay", () => {
  const fit = fitFooter(list, [40], 44, "key-first", true);
  expect(fit.takesLine).toBe(false);
  expect(fit.form).toBe(-1);
  expect(fit.hints.length).toBeGreaterThan(0);
});

test("no message gives the plain fit", () => {
  const fit = fitFooter(list, [], 120, "key-first");
  expect(ids(fit)).toEqual(ids({ hints: list }));
  expect(fit.form).toBe(-1);
  expect(fit.takesLine).toBe(false);
});
