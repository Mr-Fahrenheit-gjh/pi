let handler: (...args: any[]) => any = () => { throw new Error("unexpected suggestion request"); };
export function getSupportedThinkingLevels() { return ["off"]; }
export function setComplete(next: typeof handler) { handler = next; }
export function completeSimple(...args: any[]) { return handler(...args); }
