import { test, expect } from "bun:test";
import {
  fitHints,
  hintText,
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
