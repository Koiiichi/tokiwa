import { EmbeddedTerminalRenderable, RGBA } from "@opentui/core";

// Recognize the existing default tmux footer, including its narrow-width truncation.
// Leave unknown footer formats and ordinary application output unchanged.
export function isTmuxStatus(line: string): boolean {
  return /^\[[^\r\n]*"[^"\r\n]+"\s+\d{2}:\d{2}\s+\d{2}-[A-Z][a-z]{2}-\d{2}\s*$/.test(
    line,
  );
}

export function themeRemoteStatus(
  terminal: EmbeddedTerminalRenderable,
  foreground: string,
  background: string,
) {
  const fg = RGBA.fromHex(foreground);
  const bg = RGBA.fromHex(background);
  terminal.renderAfter = function (buffer) {
    // Preserve native selection painting. The emulator and copied text never change.
    if (terminal.hasSelection()) return;
    const screen = terminal.screen();
    const line = screen.lines[screen.rows - 1];
    if (!line || !isTmuxStatus(line)) return;
    buffer.drawText(" ".repeat(screen.columns), 0, screen.rows - 1, fg, bg);
    buffer.drawText(line, 0, screen.rows - 1, fg, bg);
  };
}
