import { createTestRenderer } from "@opentui/core/testing";
import { EmbeddedTerminalRenderable } from "@opentui/core";
const t = await createTestRenderer({ width: 80, height: 20 });
const term = new EmbeddedTerminalRenderable(t.renderer, {
  id: "scroll-fixture",
  width: 80,
  height: 20,
  maxScrollback: 200,
});
t.renderer.root.add(term);
term.focus();
term.write(
  Array.from(
    { length: 100 },
    (_, i) => `LINE_${String(i).padStart(3, "0")}\r\n`,
  ).join(""),
);
await t.renderOnce();
const before = t.captureCharFrame();
for (let i = 0; i < 10; i++) await t.mockMouse.scroll(5, 5, "up");
await t.renderOnce();
const after = t.captureCharFrame();
await Bun.write(
  process.argv[2],
  JSON.stringify(
    {
      before,
      after,
      visibleChanged: before !== after,
      hasEarlierLines: /LINE_0[0-6][0-9]/.test(after),
    },
    null,
    2,
  ),
);
await t.dispose();
