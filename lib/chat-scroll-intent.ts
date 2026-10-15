export type ChatScrollDirection = "away" | "toward";

export function scrollKeyDirection(event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">): ChatScrollDirection | null {
  if (event.altKey || event.metaKey || (event.ctrlKey && event.key !== "Home" && event.key !== "End")) return null;
  if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" || (event.key === " " && event.shiftKey)) return "away";
  if (event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End" || event.key === " ") return "toward";
  return null;
}

// Listen to intent before the browser's scroll event, so a queued streaming
// frame cannot move the transcript between a wheel/touch input and its scroll.
export function bindChatScrollIntent(container: HTMLElement, onIntent: (direction: ChatScrollDirection) => void): () => void {
  let touchY: number | null = null;

  const isTranscriptInput = (target: EventTarget | null, keyboard = false) => {
    if (!(target instanceof Element)) return true;
    if (keyboard && target.closest("input, textarea, select, button, [contenteditable]:not([contenteditable='false']), [role='slider']")) return false;
    // A code block/table has its own scroll surface. Do not detach the chat
    // while the user's wheel is consumed there.
    for (let el: Element | null = target; el && el !== container; el = el.parentElement) {
      if (!(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return false;
    }
    return true;
  };
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.deltaY === 0 || !isTranscriptInput(event.target)) return;
    onIntent(event.deltaY < 0 ? "away" : "toward");
  };
  const touchStart = (event: TouchEvent) => {
    touchY = event.touches.length === 1 && isTranscriptInput(event.target) ? event.touches[0].clientY : null;
  };
  const touchMove = (event: TouchEvent) => {
    if (event.touches.length !== 1) { touchY = null; return; }
    if (touchY === null) return;
    const next = event.touches[0].clientY;
    if (Math.abs(next - touchY) < 2) return;
    onIntent(next > touchY ? "away" : "toward");
    touchY = next;
  };
  const touchEnd = () => { touchY = null; };
  const keyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !isTranscriptInput(event.target, true)) return;
    const direction = scrollKeyDirection(event);
    if (direction) onIntent(direction);
  };
  // A direct grab of the scrollbar can reattach after an earlier wheel-up.
  const pointerDown = (event: PointerEvent) => {
    if (event.target === container && event.button === 0) onIntent("toward");
  };

  container.addEventListener("wheel", wheel, { passive: true });
  container.addEventListener("touchstart", touchStart, { passive: true });
  container.addEventListener("touchmove", touchMove, { passive: true });
  container.addEventListener("touchend", touchEnd, { passive: true });
  container.addEventListener("touchcancel", touchEnd, { passive: true });
  container.addEventListener("keydown", keyDown);
  container.addEventListener("pointerdown", pointerDown);
  return () => {
    container.removeEventListener("wheel", wheel);
    container.removeEventListener("touchstart", touchStart);
    container.removeEventListener("touchmove", touchMove);
    container.removeEventListener("touchend", touchEnd);
    container.removeEventListener("touchcancel", touchEnd);
    container.removeEventListener("keydown", keyDown);
    container.removeEventListener("pointerdown", pointerDown);
  };
}
