export interface TerminalWheelEvent {
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}

export function wheelLines(event: TerminalWheelEvent, cellHeight: number, rows: number, remainder = 0) {
  if (!Number.isFinite(event.deltaY) || event.ctrlKey) return { lines: 0, remainder: 0 };
  const delta = event.deltaMode === 1 ? event.deltaY : event.deltaMode === 2 ? event.deltaY * rows : event.deltaY / Math.max(1, cellHeight);
  const total = remainder + delta;
  const whole = Math.trunc(total);
  return { lines: Math.max(-12, Math.min(12, whole || 0)), remainder: total - whole };
}

export function mouseWheelSequence(direction: number, col: number, row: number, sgr: boolean, modifiers: Pick<TerminalWheelEvent, "shiftKey" | "altKey" | "ctrlKey">) {
  const code = (direction < 0 ? 64 : 65) + (modifiers.shiftKey ? 4 : 0) + (modifiers.altKey ? 8 : 0) + (modifiers.ctrlKey ? 16 : 0);
  return sgr ? `\x1b[<${code};${col};${row}M` : `\x1b[M${String.fromCharCode(code + 32, Math.min(223, col) + 32, Math.min(223, row) + 32)}`;
}
