// The static-markup tests do not render CSS; match the existing test hook.
import { registerHooks } from "node:module";
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: "export default {};" };
  },
});
