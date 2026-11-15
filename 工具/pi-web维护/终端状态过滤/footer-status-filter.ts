const FAST_STATUS_KEY = "codex-speed";

function footerThemeView(theme, ctx, data) {
  return new Proxy(theme, {
    get(target, key) {
      if (key === "fg") {
        return (color, text) => target.fg(
          color,
          text === ctx.model?.id && data.getExtensionStatuses().get(FAST_STATUS_KEY)
            ? `${text} ⚡`
            : text,
        );
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function footerDataView(data) {
  return new Proxy(data, {
    get(target, key) {
      if (key === "getExtensionStatuses") {
        return () => {
          // Fast is shown beside the model; no separate extension-status row.
          return new Map();
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function contextView(ctx) {
  const ui = new Proxy(ctx.ui, {
    get(target, key) {
      if (key === "setFooter") {
        return (factory) => target.setFooter(
          factory === undefined
            ? undefined
            : (tui, theme, data) => factory(tui, footerThemeView(theme, ctx, data), footerDataView(data)),
        );
      }
      return Reflect.get(target, key, target);
    },
  });
  return new Proxy(ctx, {
    get(target, key) {
      return key === "ui" ? ui : Reflect.get(target, key, target);
    },
  });
}

/** Filter the footer presented by the wrapped extension, without changing Pi's status data. */
export function withFilteredFooter(pi) {
  return new Proxy(pi, {
    get(target, key) {
      if (key === "on") {
        return (event, handler) => target.on(event, (payload, ctx) => handler(payload, contextView(ctx)));
      }
      return Reflect.get(target, key, target);
    },
  });
}
