// Beautiful TUI clears stdout on session_start, bypassing Pi's screen cache.
// Keep that clear coordinated with the renderer without intercepting global stdout.
export function withSessionRenderReset(pi) {
  let renderer;
  return new Proxy(pi, {
    get(target, key) {
      if (key !== "on") return Reflect.get(target, key, target);
      return (event, handler) => target.on(event, async (payload, ctx) => {
        if (!ctx.hasUI || (ctx.mode !== undefined && ctx.mode !== "tui")) {
          return handler(payload, ctx);
        }
        const ui = new Proxy(ctx.ui, {
          get(uiTarget, uiKey) {
            if (uiKey !== "setHeader") return Reflect.get(uiTarget, uiKey, uiTarget);
            return (factory) => {
              if (factory === undefined) {
                renderer = undefined;
                return uiTarget.setHeader(undefined);
              }
              return uiTarget.setHeader((tui, ...args) => {
                renderer = tui;
                return factory(tui, ...args);
              });
            };
          },
        });
        const view = new Proxy(ctx, {
          get(context, contextKey) {
            return contextKey === "ui" ? ui : Reflect.get(context, contextKey, context);
          },
        });
        try {
          return await handler(payload, view);
        } finally {
          if (event === "session_start") renderer?.requestRender(true);
        }
      });
    },
  });
}
