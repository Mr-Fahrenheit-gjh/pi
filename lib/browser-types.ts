export interface BrowserPageState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  width: number;
  height: number;
  error?: string;
  dialog?: { type: string; message: string; defaultPrompt: string };
}
export type BrowserEvent =
  | { type: "state"; state: BrowserPageState }
  | { type: "frame"; data: string; width: number; height: number; url: string }
  | { type: "closed" };

export type BrowserCommand =
  | { type: "navigate"; url: string }
  | { type: "reload" | "back" | "forward" | "copy" }
  | { type: "resize"; width: number; height: number }
  | { type: "text"; text: string }
  | { type: "key"; event: "keyDown" | "keyUp"; key: string; code: string; keyCode: number; modifiers: number; text?: string }
  | { type: "mouse"; event: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel"; x: number; y: number; button: "left" | "middle" | "right" | "none"; buttons: number; clickCount: number; modifiers: number; deltaX?: number; deltaY?: number }
  | { type: "dialog"; accept: boolean; promptText?: string };
