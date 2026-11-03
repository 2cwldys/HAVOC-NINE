// A2S_RULES over UDP lives in core now (lib/a2s.js), where the status poller reads it too; the
// module's enrollment and its tests keep importing it from here.
export { parseRules, queryRules } from "../../lib/a2s.js";
