// One-line logs on stdout; on the VPS journald keeps them. Callers pass an event name and a few
// plain fields. Nothing logged here may be a password, a session token or a cookie: no caller
// passes one, and every value is cut short and stripped of control characters on the way out.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function clean(value) {
  let text = value instanceof Error ? value.message : String(value);
  text = text.replace(/[\u0000-\u001f\u007f]+/g, " ");
  if (text.length > 200) text = text.slice(0, 200) + "...";
  return /[\s"=]/.test(text) || text === "" ? JSON.stringify(text) : text;
}

export function createLogger(scope = "h9web", options = {}) {
  const threshold = LEVELS[options.level || "info"] ?? LEVELS.info;
  const sink = options.sink || ((level, line) => (level === "error" || level === "warn" ? console.error(line) : console.log(line)));

  function write(level, event, fields) {
    if (LEVELS[level] < threshold) return;
    let line = new Date().toISOString().replace(/\.\d+Z$/, "Z") + " " + level.padEnd(5) + " [" + scope + "] " + event;
    if (fields && typeof fields === "object") {
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        line += " " + key + "=" + clean(value);
      }
    }
    sink(level, line);
  }

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (name) => createLogger(scope + "/" + name, options),
  };
}
