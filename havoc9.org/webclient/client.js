// HAVOC 9 web client: runs H9XASH (Xash3D FWGS built for WebAssembly) and the game in this page.
//
// settings.json, beside this file, says where the build is and how the game reaches servers:
//   engine     folder with xash.js and xash.wasm, the engine build
//   game       folder the game files are served from: the root of the engine's disk
//   manifest   every game file with its size and hash (tools\make_webclient_game.py)
//   preload    the files fetched before the engine starts; optional
//   gamedir    the game's folder on that disk
//   args       more engine command line arguments
//   commands   console commands run once the engine is up
//   fonts      browser fonts for VGUI text: [{ family, file, weight, style }], file as the manifest
//              names it; in place of the manifest's own list, which the packer makes from fonts.txt
//   relay      the relay's path on this site, or a wss:// URL: one relay for every H9 server
//   master     the address the relay answers as the master server, which the game's server browser
//              asks for H9's servers
//   servers    [{ name, address: "ip:port" }]: small JOIN links under PLAY, shortcuts to a server
//
// PLAY starts the game to its main menu, as starting H9XASH does: the player finds a server in the
// menu's server browser and joins it there, and can leave it and join another without reloading
// the page. Until engine/xash.js and the manifest can both be fetched, the page keeps its own text,
// which says the client is in preparation.
//
// A page has no UDP. Each engine socket is one WebSocket to the relay, and each message on it is
// one datagram: 4 bytes of IPv4 address and 2 of port, both in network order, then the payload.
// The address is the destination on the way out and the source on the way in, so the engine
// talks to every server by its own address. The relay sends only to H9's servers and answers the
// master address with their list. LAN discovery (broadcast) is not carried.
//
// The engine reads its disk from memory. Each file in the manifest is there from the start with
// its size; its bytes are fetched the first time the engine reads it, and the engine waits for
// them. The preload list is fetched ahead, several files at a time, so a start does not wait on
// hundreds of single reads.
//
// A server's splash MOTD (docs\H9_MOTD.txt), a picture or a web page in place of TS's text MOTD,
// is shown by this page over the game (motdOverlay), when the engine hands it over.
//
// Kept in this browser (localStorage): the player's config.cfg, the engine's .xash_id and, when no
// account is signed in, a random H9 client id. A signed-in page hands over the account's player id
// (window.h9webAccount.playerId), which becomes cl_h9_userid instead. The page talks to nothing but
// this site and its relay.
// window.h9web holds the engine's log and the module, for the browser's console.
(() => {
  "use strict";

  const DEFAULTS = {
    engine: "engine/", game: "game/", manifest: "manifest.json", preload: "preload.json",
    gamedir: "ts", args: [], commands: [], fonts: [], relay: "relay", master: "192.0.2.1:27010", servers: [],
  };
  const KEY = { config: "h9web.config", xashId: "h9web.xash_id", userId: "h9web.userid" };
  const $ = (id) => document.getElementById(id);
  const folder = (path) => new URL(path.endsWith("/") ? path : path + "/", location.href);
  const mb = (n) => (n / 1048576).toFixed(0);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: not kept */ } },
  };

  let settings = DEFAULTS;
  let engineBase = null, gameBase = null, manifest = null, manifestFonts = [], mod = null;
  let manifestLower = null, menuVideo = null;
  // the site's front page: where the game's X, Quit and LEAVE go, as closing H9XASH ends a session
  const HOME = new URL("../index.html", location.href).href;
  let started = false, stopped = false, leaving = false, configKept = null;
  const log = [];
  window.h9web = { log, module: () => mod };

  function note(line) {
    log.push(String(line));
    if (log.length > 4000) log.splice(0, 1000);
    console.log(line);
  }

  function say(title, text, detail) {
    $("webclientTitle").textContent = title;
    $("webclientText").textContent = text;
    $("webclientDetail").textContent = detail;
  }

  function status(text) {
    const el = $("stageStatus");
    el.textContent = text;
    el.hidden = !text;
  }

  async function init() {
    try {
      const r = await fetch("settings.json", { cache: "no-cache" });
      if (r.ok) settings = Object.assign({}, DEFAULTS, await r.json());
    } catch (e) { /* the defaults stand */ }
    engineBase = folder(settings.engine);
    gameBase = folder(settings.game);
    const built = await reachable(new URL("xash.js", engineBase)) && await reachable(new URL(settings.manifest, location.href));
    if (!built) return;
    if (!webgl2()) {
      say("WEBGL 2 NEEDED", "This browser cannot draw the game: it offers no WebGL 2.",
        "Use a current Chrome, Edge or Firefox with hardware acceleration turned on.");
      return;
    }
    // H9 accounts (auth.js): PLAY only for a signed-in player; otherwise auth.js offers SIGN IN and CREATE ACCOUNT
    if (window.h9auth && !(await window.h9auth.ready())) return;
    offer();
  }

  async function reachable(url) {
    try {
      let r = await fetch(url, { method: "HEAD", cache: "no-cache" });
      if (r.status === 405 || r.status === 501) r = await fetch(url, { cache: "no-cache" });
      return r.ok;
    } catch (e) {
      return false;
    }
  }

  function webgl2() {
    try {
      const gl = document.createElement("canvas").getContext("webgl2");
      if (!gl) return false;
      // a browser keeps only a few contexts, and the engine's must not be the one it drops
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
      return true;
    } catch (e) {
      return false;
    }
  }

  // PLAY starts the game to its main menu, where the server browser lists H9's servers. Each server
  // in settings.json with an address is also a small JOIN link under it, a shortcut that joins it
  // as soon as the game is up.
  function offer() {
    const servers = (settings.servers || []).filter((s) => s && s.address);
    say("PLAY IN YOUR BROWSER", "HAVOC 9 runs in this tab: no download, no install. Find a server in the game's menu, as in H9XASH.",
      "The first start fetches the game files it needs and takes a while; the browser keeps them for the next.");
    const box = $("webclientActions");
    box.textContent = "";
    const play = document.createElement("button");
    play.type = "button";
    play.className = "btn btn-primary";
    play.textContent = "PLAY";
    play.addEventListener("click", () => launch(null));
    box.appendChild(play);
    if (!servers.length) return;
    const line = document.createElement("p");
    line.className = "dim";
    line.style.cssText = "flex-basis: 100%; margin: 0.5rem 0 0; font-size: 0.85rem;";
    line.append("Or join directly: ");
    servers.forEach((s, i) => {
      if (i) line.append(" \u00b7 ");
      const a = document.createElement("a");
      a.href = "#";
      a.style.color = "var(--orange)";
      a.textContent = String(s.name || s.address);
      a.addEventListener("click", (e) => {
        e.preventDefault();
        launch(s);
      });
      line.appendChild(a);
    });
    box.appendChild(line);
  }

  async function launch(server) {
    if (started) return;
    started = true;
    document.documentElement.classList.add("webclient-playing");
    $("stage").hidden = false;
    $("canvas").focus();
    status("Reading the file list");
    try {
      manifest = await readManifest();
      await loadFonts();
      menuVideo = await pickMenuVideo();
      const warm = await preload(menuVideo ? [menuVideo.path] : []);
      status("Loading the engine");
      await addScript(new URL("xash.js", engineBase).href);
      if (typeof window.Xash3D !== "function") throw new Error("xash.js did not define Xash3D");
      keepFramesInHiddenTab();
      status("Starting the engine");
      const m = await window.Xash3D(engineConfig(server, warm));
      if (!mod) mod = m;
    } catch (e) {
      stop("The game could not start: " + (e && e.message ? e.message : e) + ".");
    }
  }

  async function readManifest() {
    const r = await fetch(settings.manifest, { cache: "no-cache" });
    if (!r.ok) throw new Error("the file list answered " + r.status);
    const m = await r.json();
    const files = Array.isArray(m) ? m : m.files;
    if (!Array.isArray(files) || !files.length) throw new Error("the file list is empty");
    manifestFonts = !Array.isArray(m) && Array.isArray(m.fonts) ? m.fonts : [];
    manifestLower = new Map(files.map((f) => [f.path.toLowerCase(), f]));
    return new Map(files.map((f) => [f.path, f]));
  }

  // A game file by its path, as the game spells it: the disk H9XASH comes from does not care for case.
  function findFile(path) {
    return manifest.get(path) || manifestLower.get(path.toLowerCase()) || null;
  }

  // The names in one of h9xash.bat's lists (menu_music.txt, menu_bg_videos.txt): one a line, # a comment.
  function listNames(bytes) {
    return new TextDecoder().decode(bytes).split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s[0] !== "#");
  }

  // The main menu's video, as h9xash.bat picks it: a random line of menu_bg_videos.txt, a file in the
  // game's media folder. menu_bg_video_resolved.cfg hands it to the menu, the engine opens it, and the
  // page decodes it (pageVideo); it is fetched with the preload, so the menu does not wait for it.
  async function pickMenuVideo() {
    try {
      const listFile = findFile(settings.gamedir + "/menu_bg_videos.txt");
      if (!listFile) return null;
      const names = listNames(await fetchBytes(listFile));
      if (!names.length) return null;
      const name = names[Math.floor(Math.random() * names.length)];
      const f = findFile(settings.gamedir + "/media/" + name);
      if (!f) {
        note("page: menu video " + name + " is not in the file list");
        return null;
      }
      return { name, path: f.path };
    } catch (e) {
      note("page: no menu video: " + (e && e.message ? e.message : e));
      return null;
    }
  }

  // The hash in the address makes a changed file a new address, so the browser never mixes an
  // old copy with a new manifest.
  function fileUrl(f) {
    return new URL(f.path.split("/").map(encodeURIComponent).join("/") + "?v=" + (f.hash || f.size), gameBase).href;
  }

  // VGUI text is drawn through a canvas with the fonts the page has. Each entry registers a game
  // font under the family name the game asks for, as fonts.txt maps them on Windows: the manifest's
  // list, made from fonts.txt, unless settings.json gives one. All are loaded before the engine
  // starts, because VGUI draws the letters of a font once, when the font is made.
  async function loadFonts() {
    if (typeof FontFace !== "function") return;
    const list = settings.fonts && settings.fonts.length ? settings.fonts : manifestFonts;
    await Promise.all(list.map(async (x) => {
      const f = x && x.family && manifest.get(x.file);
      if (!f) return;
      try {
        const face = new FontFace(x.family, "url(\"" + fileUrl(f) + "\")", { weight: x.weight || "100 900", style: x.style || "normal" });
        document.fonts.add(await face.load());
      } catch (e) {
        note("page: font " + x.file + " not loaded: " + e.message);
      }
    }));
  }

  async function preload(extra) {
    const warm = new Map();
    let list = [];
    try {
      const r = await fetch(settings.preload, { cache: "no-cache" });
      if (r.ok) list = await r.json();
    } catch (e) { /* no list: every file is read when the engine asks for it */ }
    const todo = (Array.isArray(list) ? list : []).concat(extra || []).map((p) => manifest.get(p)).filter(Boolean);
    const total = todo.reduce((n, f) => n + f.size, 0);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < todo.length) {
        const f = todo[next++];
        try {
          const r = await fetch(fileUrl(f));
          if (r.ok) warm.set(f.path, new Uint8Array(await r.arrayBuffer()));
        } catch (e) { /* read again when the engine asks for it */ }
        done += f.size;
        status("Downloading the game: " + mb(done) + " of " + mb(total) + " MB");
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return warm;
  }

  function addScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("could not load " + src));
      document.head.appendChild(s);
    });
  }

  function engineConfig(server, warm) {
    const width = Math.max(640, Math.round(window.innerWidth));
    const height = Math.max(480, Math.round(window.innerHeight));
    const config = {
      canvas: $("canvas"),
      // -console as h9xash.bat starts the native game: without it the engine has no console and prints nothing
      arguments: ["-game", settings.gamedir, "-console", "-ref", "webgl2", "-windowed", "-width", String(width), "-height", String(height)]
        .concat(settings.args || []),
      print: note,
      printErr: note,
      locateFile: (name) => new URL(name, engineBase).href,
      net: relayNet(settings.relay),
      video: pageVideo(() => config.FS),
      motd: motdOverlay(),
      preRun: [(m) => mountDisk((m && m.FS) || config.FS, warm)],
      callbacks: {
        gameReady: () => onReady(config, server, warm),
        // the menu's X and Quit, and quit or exit in the console; an error ends here too and stays on screen
        gameQuit: (error) => (error ? stop("The game stopped with an error.") : goHome()),
        // the menu's minimize button: a page has no window to minimize
        gameMinimize: () => leaveFullscreen(),
      },
      onExit: () => goHome(),
      onAbort: (what) => stop("The game stopped: " + what + "."),
    };
    return config;
  }

  // The engine's disk: every manifest file as a lazy file, then the player's own files.
  function mountDisk(FS, warm) {
    const own = playerFiles(settings.gamedir);
    const ownLower = new Set(Array.from(own.keys(), (p) => p.toLowerCase()));
    const made = new Set();
    const dirOf = (path) => {
      const dir = "/" + path.split("/").slice(0, -1).join("/");
      if (dir !== "/" && !made.has(dir)) {
        FS.mkdirTree(dir);
        made.add(dir);
      }
      return dir;
    };
    for (const f of manifest.values()) {
      if (!ownLower.has(f.path.toLowerCase())) lazyFile(FS, dirOf(f.path), f.path.split("/").pop(), f, warm);
    }
    for (const [path, text] of own) {
      dirOf(path);
      FS.writeFile("/" + path, text);
    }
    FS.chdir("/");
  }

  // What h9xash.bat writes for each player on Windows, written here for this browser. userconfig.cfg
  // runs these before the menu shows.
  function playerFiles(gd) {
    const own = new Map();
    const account = window.h9webAccount && String(window.h9webAccount.playerId || "").toLowerCase();
    let id = account, from = "this account's player id";
    if (!/^[0-9a-f]{32}$/.test(id || "")) {
      from = "this browser's id";
      id = store.get(KEY.userId);
      if (!/^[0-9a-f]{32}$/.test(id || "")) {
        const b = new Uint8Array(16);
        crypto.getRandomValues(b);
        id = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
        store.set(KEY.userId, id);
      }
    }
    own.set(gd + "/userid_resolved.cfg", "// Written by the web client from " + from + ".\ncl_h9_userid \"" + id + "\"\n");
    // the server browser's one master: the relay answers it with H9's servers. The engine's HTTP
    // server lists (addmasterstatic) cannot be fetched from a page.
    own.set(gd + "/networking_resolved.cfg", "clearmasters\naddmaster " + settings.master + "\n");
    // the menu's music is started by the page once its track is here (startMenuMusic)
    own.set(gd + "/menu_music_resolved.cfg", "");
    // the menu's video, as h9xash.bat writes it (pickMenuVideo)
    own.set(gd + "/menu_bg_video_resolved.cfg", menuVideo ? "ui_background_video_file \"" + menuVideo.name + "\"\n" : "");
    // runs at every start, after config.cfg: H9's colours and the files above, whatever config.cfg holds
    own.set(gd + "/userconfig.d/h9web.cfg", "exec userconfig.cfg\n");
    const cfg = store.get(KEY.config);
    if (cfg) own.set(gd + "/config.cfg", cfg);
    const xid = store.get(KEY.xashId);
    if (/^[0-9A-Fa-f]{16}$/.test(xid || "")) own.set(gd + "/.xash_id", xid);
    return own;
  }

  // A file whose bytes arrive the first time the engine reads them. The engine's memory file
  // system reads node.contents and node.usedBytes; until it writes to the file, they come from
  // the preload or from the server.
  function lazyFile(FS, parent, name, f, warm) {
    const node = FS.createFile(parent, name, {}, true, true);
    let bytes = null, used = f.size, loaded = false;
    Object.defineProperties(node, {
      contents: {
        get() {
          if (!loaded) {
            loaded = true;
            bytes = warm.get(f.path) || readNow(f);
            warm.delete(f.path);
            used = bytes.length;
          }
          return bytes;
        },
        set(v) { loaded = true; bytes = v; },
        configurable: true,
      },
      usedBytes: {
        get() { return used; },
        set(v) { used = v; },
        configurable: true,
      },
    });
  }

  // The main thread can only read synchronously as text, so the bytes travel as a
  // user-defined charset, one character per byte.
  function readNow(f) {
    const began = performance.now();
    const x = new XMLHttpRequest();
    x.open("GET", fileUrl(f), false);
    x.overrideMimeType("text/plain; charset=x-user-defined");
    try {
      x.send(null);
    } catch (e) {
      note("page: " + f.path + " could not be read: " + e.message);
      return new Uint8Array(0);
    }
    if (x.status !== 200) {
      note("page: " + f.path + " answered " + x.status);
      return new Uint8Array(0);
    }
    const text = x.responseText, out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 255;
    const waited = performance.now() - began;
    if (waited > 250) note("page: waited " + Math.round(waited) + " ms for " + f.path);
    return out;
  }

  // The engine calls this at the end of its start, with the main menu up. The module object may not
  // be handed back yet.
  function onReady(config, server, warm) {
    status("");
    const run = () => {
      const m = mod || (typeof config.ccall === "function" ? config : null);
      if (!m) return setTimeout(run, 100);
      mod = m;
      try {
        const xid = m.FS.readFile("/" + settings.gamedir + "/.xash_id", { encoding: "utf8" }).trim();
        if (/^[0-9A-Fa-f]{16}$/.test(xid)) store.set(KEY.xashId, xid);
      } catch (e) { /* the engine has not written one */ }
      setInterval(() => saveConfig(true), 15000);
      for (const c of settings.commands || []) command(c);
      if (server) command("connect " + server.address);
      else startMenuMusic(warm);
    };
    run();
  }

  // The main menu's music, as h9xash.bat starts it: a random track from menu_music.txt. A track is
  // up to 20 MB, so it is fetched in the background and started once it is here; the menu never
  // waits for it, and its file is read from memory.
  async function startMenuMusic(warm) {
    try {
      const listFile = findFile(settings.gamedir + "/menu_music.txt");
      if (!listFile) return;
      const names = listNames(await fetchBytes(listFile));
      if (!names.length) return;
      const name = names[Math.floor(Math.random() * names.length)];
      const f = findFile(settings.gamedir + "/sound/music/" + name);
      if (!f) return;
      warm.set(f.path, await fetchBytes(f, "low"));
      if (stopped) return;
      command("mp3 loop sound/music/" + name);
      note("page: menu music " + name);
    } catch (e) {
      note("page: no menu music: " + (e && e.message ? e.message : e));
    }
  }

  async function fetchBytes(f, priority) {
    const r = await fetch(fileUrl(f), priority ? { priority } : undefined);
    if (!r.ok) throw new Error(f.path + " answered " + r.status);
    return new Uint8Array(await r.arrayBuffer());
  }

  // Queued: it runs in the engine's next frame, never inside another command.
  function command(text) {
    try { mod.ccall("Cbuf_AddText", null, ["string"], [text + "\n"]); } catch (e) { note("page: " + e.message); }
  }

  // config.cfg is memory here. The engine writes it on host_writeconfig; the copy it wrote last is
  // kept in the browser and put back on the next start.
  function saveConfig(ask) {
    if (!mod || stopped) return;
    try {
      const text = mod.FS.readFile("/" + settings.gamedir + "/config.cfg", { encoding: "utf8" });
      if (text !== configKept) {
        store.set(KEY.config, text);
        configKept = text;
      }
    } catch (e) { /* not written yet */ }
    if (ask) command("host_writeconfig");
  }

  function stop(text) {
    if (stopped) return;
    saveConfig(false);
    stopped = true;
    if (document.exitPointerLock) document.exitPointerLock();
    status(text + " Reload the page to play again, or LEAVE for the front page.");
  }

  // Back to the site's front page, as closing H9XASH ends a session: the player's config.cfg, which the
  // engine writes as it shuts down, is kept first, and nothing asks whether to leave the page.
  function goHome() {
    saveConfig(false);
    leaving = true;
    location.href = HOME;
  }

  // The browser's version of minimizing: out of full screen, the mouse given back.
  function leaveFullscreen() {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    if (document.exitPointerLock) document.exitPointerLock();
  }

  // The engine's videos (the main menu's background, engine-h9-webmenu.patch): the browser build has no
  // FFmpeg, so the page decodes them. An AVI of Motion-JPEG frames, as H9's menu video is, is a row of
  // complete JPEG pictures, which the browser decodes itself. Any other AVI is refused and the menu
  // keeps its colour background (the packer re-encodes such a menu video to MJPEG when it can).
  // open(path) answers { handle, width, height }, frame() writes the picture due now into the engine's
  // memory as RGBA when it is a new one, and the video loops at the AVI's own frame rate.
  function pageVideo(fs) {
    const videos = new Map();
    let next = 1;

    function readAvi(b) {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
      if (b.length < 12 || tag(0) !== "RIFF" || tag(8) !== "AVI ") return null;
      const avi = { width: 0, height: 0, frameUs: 100000, frames: [] };
      const walk = (start, end) => {
        for (let o = start; o + 8 <= end;) {
          const id = tag(o), size = dv.getUint32(o + 4, true), body = o + 8;
          if (body + size > end) break;
          if (id === "LIST") walk(body + 4, body + size);
          else if (id === "avih" && size >= 40) {
            avi.frameUs = dv.getUint32(body, true) || avi.frameUs;
            avi.width = dv.getUint32(body + 32, true);
            avi.height = dv.getUint32(body + 36, true);
          } else if (/^\d\dd[cb]$/.test(id) && size > 4 && b[body] === 0xFF && b[body + 1] === 0xD8) {
            avi.frames.push([body, size]);
          }
          o = body + size + (size & 1);
        }
      };
      walk(12, b.length);
      return avi;
    }

    return {
      open(path) {
        let bytes;
        try {
          bytes = fs().readFile(path[0] === "/" ? path : "/" + path);
        } catch (e) {
          return null;
        }
        const avi = readAvi(bytes);
        if (!avi || !avi.frames.length || avi.width <= 0 || avi.height <= 0) {
          note("page: " + path + " is not a Motion-JPEG AVI; the menu keeps its colour background");
          return null;
        }
        const v = { count: avi.frames.length, frameMs: avi.frameUs / 1000, pictures: null, rgba: [], start: 0, last: -1, ctx: null, closed: false };
        Promise.all(avi.frames.map(([at, size]) => createImageBitmap(new Blob([bytes.subarray(at, at + size)], { type: "image/jpeg" }))))
          .then((pictures) => {
            if (v.closed) pictures.forEach((p) => p.close());
            else v.pictures = pictures;
          })
          .catch((e) => note("page: " + path + ": a frame could not be decoded: " + e.message));
        const handle = next++;
        videos.set(handle, v);
        return { handle, width: avi.width, height: avi.height };
      },
      frame(handle, heap, dst, width, height) {
        const v = videos.get(handle);
        if (!v || !v.pictures) return false;
        const now = performance.now();
        if (!v.start) v.start = now;
        const i = Math.floor((now - v.start) / v.frameMs) % v.count;
        if (i === v.last) return false;
        v.last = i;
        let px = v.rgba[i];
        if (!px) {
          if (!v.ctx) {
            const c = document.createElement("canvas");
            c.width = width;
            c.height = height;
            v.ctx = c.getContext("2d", { willReadFrequently: true });
          }
          v.ctx.drawImage(v.pictures[i], 0, 0, width, height);
          px = v.ctx.getImageData(0, 0, width, height).data;
          // a short video is kept decoded (H9's: 12 frames of 900 x 387, 17 MB); a long one is not
          if (v.count * width * height * 4 <= 64 * 1048576) v.rgba[i] = px;
        }
        heap.set(px, dst);
        return true;
      },
      close(handle) {
        const v = videos.get(handle);
        if (!v) return;
        v.closed = true;
        if (v.pictures) v.pictures.forEach((p) => p.close());
        videos.delete(handle);
      },
    };
  }

  // A server's splash MOTD (docs\H9_MOTD.txt): at join, a server running h9_motd.sma asks for a
  // picture or a web page in place of TS's text MOTD. The engine (engine-h9-motd.patch) checks the
  // message and the player's cl_h9_motd, holds the text MOTD and hands the splash here through
  // Module.motd: show({ type, image, page, title }) answers true when it will show it, hide()
  // takes it down. Once it is on screen the page runs h9_motd_result 1; when it cannot be shown,
  // h9_motd_result 0, and the engine shows the text MOTD instead (it does the same after 10 s
  // without an answer).
  //   A picture is fetched by the browser with no referrer and shown once it has loaded, and only
  // up to MAX_SIDE pixels a side. A page is shown in a sandboxed frame: its scripts, forms and links
  // work (a link opens in a new tab, only on the player's click), but it runs as an opaque origin,
  // with no access to this page, to this site's cookies or to its own storage, no referrer, none of
  // the browser's permissions (camera, microphone, location, full screen and the like) and no
  // dialogs; where the browser offers it, the frame is credentialless as well. Its host is always
  // on screen, and OPEN PAGE shows the whole address before a second click opens it in a new tab.
  //   An address must be https with a host name (no IP address, no user name), and one on this site
  // itself only under /motd/: anything else here would be fetched with the player's sign-in.
  //   While it is up the game gets no key presses (releases still reach it, so nothing stays held)
  // and no mouse; Esc or CLOSE end it, and the game has the keyboard and the mouse back.
  function motdOverlay() {
    const MAX_SIDE = 2048;
    let box = null, pending = null;

    function address(raw, picture) {
      const text = String(raw || "");
      let u;
      if (!text || text.length > 255) return null;
      try {
        u = new URL(text);
      } catch (e) {
        return null;
      }
      const host = u.hostname.toLowerCase();
      if (u.protocol !== "https:" || u.username || u.password) return null;
      if (!/^[a-z0-9.-]+$/.test(host) || !/[a-z]/.test(host) || !host.includes(".") || host.startsWith(".") || host.endsWith(".")) return null;
      const own = location.hostname.toLowerCase();
      if ((host === own || host.endsWith("." + own)) && !u.pathname.startsWith("/motd/")) return null;
      if (picture && u.hash) return null;
      return u;
    }

    // the engine's h9_motd_result; the module is up by the time a server is joined
    function answer(shown, tries) {
      if (stopped) return;
      if (!mod) {
        if ((tries || 0) < 25) setTimeout(() => answer(shown, (tries || 0) + 1), 200);
        return;
      }
      command("h9_motd_result " + (shown ? 1 : 0));
    }

    function el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    }

    function button(label, cls, onClick) {
      const b = el("button", "btn " + cls, label);
      b.type = "button";
      b.addEventListener("click", onClick);
      return b;
    }

    // the player closes it: the game has the keyboard back
    function close() {
      hide();
      $("canvas").focus();
    }

    function hide() {
      if (pending) {
        pending.onload = pending.onerror = null;
        pending.src = "";
        pending = null;
      }
      if (box) {
        const had = box.contains(document.activeElement);
        box.remove();
        box = null;
        if (had) $("canvas").focus();
      }
    }

    // OPEN PAGE: the whole address and its site first, then a link the player clicks
    function confirmRow(foot, url) {
      const row = el("div", "motd-confirm");
      row.appendChild(el("p", "", "Open this address in a new tab?"));
      row.appendChild(el("p", "motd-site", "Site: " + url.hostname));
      row.appendChild(el("p", "motd-url", url.href));
      const go = el("a", "btn btn-primary", "OPEN IN NEW TAB");
      go.href = url.href;
      go.target = "_blank";
      go.rel = "noopener noreferrer";
      go.referrerPolicy = "no-referrer";
      go.addEventListener("click", () => setTimeout(() => row.replaceWith(foot), 0));
      const actions = el("div", "motd-actions");
      actions.appendChild(go);
      actions.appendChild(button("CANCEL", "btn-ghost", () => row.replaceWith(foot)));
      row.appendChild(actions);
      foot.replaceWith(row);
      go.focus();
    }

    function show(m) {
      hide();
      const isPage = !!m && m.type === "page";
      const page = m && m.page ? address(m.page, false) : null;
      const pic = !isPage && m && m.image ? address(m.image, true) : null;
      if (isPage ? !page : !pic) {
        note("page: splash MOTD refused: its address is not one this page shows");
        return false;
      }

      const shown = el("div", "motd");
      shown.setAttribute("role", "dialog");
      shown.setAttribute("aria-modal", "true");
      shown.setAttribute("aria-label", "Message of the day");
      const panel = el("div", "motd-panel");
      const head = el("div", "motd-head");
      const titles = el("div", "motd-titles");
      titles.appendChild(el("div", "motd-title", String(m.title || "") || "Message of the day"));
      titles.appendChild(el("div", "motd-source", isPage ? "Web page at " + page.hostname : "Picture from " + pic.hostname));
      head.appendChild(titles);
      head.appendChild(button("CLOSE (ESC)", "btn-ghost", close));
      const body = el("div", "motd-body");
      const foot = el("div", "motd-actions");
      if (page) foot.appendChild(button((isPage ? "OPEN IN NEW TAB (" : "OPEN PAGE (") + page.hostname + ")", "btn-ghost", () => confirmRow(foot, page)));
      panel.appendChild(head);
      panel.appendChild(body);
      if (page) panel.appendChild(foot);
      shown.appendChild(panel);
      box = shown;

      const put = () => {
        $("stage").appendChild(shown);
        if (document.exitPointerLock) document.exitPointerLock();
        const first = head.querySelector("button");
        if (first) first.focus();
      };

      if (isPage) {
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox");
        frame.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'; fullscreen 'none'; payment 'none'; usb 'none'; display-capture 'none'; clipboard-read 'none'");
        frame.setAttribute("credentialless", "");
        frame.referrerPolicy = "no-referrer";
        frame.title = "Page from " + page.hostname;
        frame.src = page.href;
        body.appendChild(frame);
        put();
        setTimeout(() => answer(true), 0);
        return true;
      }

      // the picture is shown once it is here and its size is known; until then the game plays on
      const img = new Image();
      pending = img;
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.alt = "Message of the day from " + pic.hostname;
      img.onload = () => {
        if (box !== shown) return;
        pending = null;
        if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth > MAX_SIDE || img.naturalHeight > MAX_SIDE) {
          note("page: splash picture refused: " + img.naturalWidth + " x " + img.naturalHeight + ", over " + MAX_SIDE + " a side");
          hide();
          answer(false);
          return;
        }
        body.appendChild(img);
        put();
        answer(true);
      };
      img.onerror = () => {
        if (box !== shown) return;
        pending = null;
        note("page: splash picture could not be loaded from " + pic.hostname);
        hide();
        answer(false);
      };
      img.src = pic.href;
      return true;
    }

    // Key presses go to the splash, not the game, while it is on screen: the engine listens on the
    // window, so this listener (made before the engine starts) stops them at the window first.
    // Releases pass, so a key held as it came up is let go in the game.
    const keys = (e) => {
      if (!box || !box.isConnected) return;
      if (e.type === "keydown" && e.key === "Escape") {
        e.preventDefault();
        close();
      }
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", keys, true);
    window.addEventListener("keypress", keys, true);

    return { show, hide };
  }

  // The engine draws, and with that talks to the server, once per animation frame, and a hidden
  // tab gets none: the server would drop the player. While the tab is hidden, a worker's clock
  // runs the waiting frames ten times a second.
  function keepFramesInHiddenTab() {
    const raf = window.requestAnimationFrame.bind(window);
    const caf = window.cancelAnimationFrame.bind(window);
    const waiting = new Map();
    let seq = 0;
    window.requestAnimationFrame = (cb) => {
      const id = ++seq;
      waiting.set(id, { cb, real: raf((t) => { if (waiting.delete(id)) cb(t); }) });
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      const w = waiting.get(id);
      if (w) {
        waiting.delete(id);
        caf(w.real);
      }
    };
    try {
      const src = "setInterval(function () { postMessage(0); }, 100);";
      const clock = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      clock.onmessage = () => {
        if (!document.hidden) return;
        const now = performance.now();
        for (const [id, w] of Array.from(waiting)) {
          waiting.delete(id);
          caf(w.real);
          w.cb(now);
        }
      };
    } catch (e) { /* no worker: the game pauses while its tab is hidden */ }
  }

  function wsUrl(path) {
    const u = new URL(path, location.href);
    if (u.protocol === "https:") u.protocol = "wss:";
    else if (u.protocol === "http:") u.protocol = "ws:";
    return u.href;
  }

  // The engine's sockets (engine/platform/emscripten/net_emscripten.js calls these through
  // Module.net). Each socket is one WebSocket to the relay, opened on its first datagram; a closed
  // one is opened again on the next, and the relay then sends from a new port. Every message is one
  // datagram: 4 bytes of IPv4 address and 2 of port in network order, then the payload, the
  // destination on the way out and the source on the way in. The engine puts heap() and setErrno()
  // on this object when it makes its first socket.
  function relayNet(relayPath) {
    const AF_INET = 2, SOCK_DGRAM = 2;
    const EAGAIN = 6, EAFNOSUPPORT = 5; // Emscripten's errno numbers; EAGAIN is "no packet yet"
    const relay = wsUrl(relayPath || "relay");
    const sockets = new Map();
    const stats = { sent: 0, received: 0, dropped: 0 };
    let nextFd = 100, relayTold = false;

    const net = {
      stats,
      socket(family, type) {
        if (family !== AF_INET || (type & 15) !== SOCK_DGRAM) return fail(EAFNOSUPPORT);
        sockets.set(nextFd, { ws: null, pending: [], inbox: [], closed: false, retryAt: 0, backoff: 0 });
        return nextFd++;
      },
      bind: () => 0,
      closesocket(fd) {
        const sock = sockets.get(fd);
        if (sock) {
          sock.closed = true;
          try { if (sock.ws) sock.ws.close(); } catch (e) { /* already closed */ }
        }
        sockets.delete(fd);
        return 0;
      },
      sendto(fd, buf, len, flags, addr) {
        const sock = sockets.get(fd), h = net.heap();
        if (!sock || !addr || (h[addr] | (h[addr + 1] << 8)) !== AF_INET) return len;
        // a broadcast is the LAN tab's discovery, which a relay cannot carry
        if (h[addr + 4] === 255 && h[addr + 5] === 255 && h[addr + 6] === 255 && h[addr + 7] === 255) {
          stats.dropped++;
          return len;
        }
        const frame = new Uint8Array(6 + len);
        frame.set(h.subarray(addr + 4, addr + 8), 0);
        frame[4] = h[addr + 2];
        frame[5] = h[addr + 3];
        frame.set(h.subarray(buf, buf + len), 6);
        const ws = link(sock);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(frame);
          stats.sent++;
        } else if (ws && ws.readyState === WebSocket.CONNECTING && sock.pending.length < 256) {
          sock.pending.push(frame);
        } else {
          stats.dropped++;
        }
        return len;
      },
      recvfrom(fd, buf, len, flags, addr, addrlen) {
        const sock = sockets.get(fd);
        const p = sock && sock.inbox.shift();
        if (!p) return fail(EAGAIN);
        const h = net.heap(), n = Math.min(len, p.length - 6);
        h.set(p.subarray(6, 6 + n), buf);
        if (addr) {
          h.fill(0, addr, addr + 16);
          h[addr] = AF_INET;
          h[addr + 2] = p[4];
          h[addr + 3] = p[5];
          h.set(p.subarray(0, 4), addr + 4);
          if (addrlen) h.set([16, 0, 0, 0], addrlen);
        }
        stats.received++;
        return n;
      },
      select: () => 0,
      connect: () => fail(EAFNOSUPPORT),
      send: () => fail(EAFNOSUPPORT),
      recv: () => fail(EAGAIN),
      getsockname: () => -1,
      gethostname: () => -1,
      gethostbyname: () => 0,
      getaddrinfo: () => -1, // names are not resolved here: servers are given as ip:port
    };

    function fail(code) {
      if (net.setErrno) net.setErrno(code);
      return -1;
    }

    // A WebSocket the relay refused (it answers the upgrade with an HTTP status, which the page
    // only sees as a close before any open) or closed for sending too much is asked for again
    // after a pause: 3 s, then twice as long each time up to 30 s, so the engine's datagrams in
    // between do not make a storm of upgrades. An idle close is not a refusal: the next datagram
    // opens a new one at once. The datagrams of a pause are dropped; the engine sends again.
    function link(sock) {
      if (sock.ws && (sock.ws.readyState === WebSocket.CONNECTING || sock.ws.readyState === WebSocket.OPEN)) return sock.ws;
      if (performance.now() < sock.retryAt) return null;
      let ws, opened = false;
      try {
        ws = new WebSocket(relay);
      } catch (e) {
        note("net: no relay: " + e.message);
        return null;
      }
      ws.binaryType = "arraybuffer";
      sock.ws = ws;
      sock.pending = [];
      ws.onopen = () => {
        opened = true;
        sock.backoff = 0;
        for (const frame of sock.pending) ws.send(frame);
        stats.sent += sock.pending.length;
        sock.pending = [];
        note("net: relay open");
        if (relayTold) {
          relayTold = false;
          status("");
        }
      };
      ws.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer) || e.data.byteLength < 6) return;
        if (sock.inbox.length < 1024) sock.inbox.push(new Uint8Array(e.data));
        else stats.dropped++;
      };
      ws.onclose = (e) => {
        if (sock.ws === ws) sock.ws = null;
        if (sock.closed) return;
        note("net: relay closed, code " + e.code + (e.reason ? ": " + e.reason : "") + (opened ? "" : ", before it opened"));
        // the relay's close codes: 4401 the session ended, 4403 the account is suspended
        if (e.code === 4401 || e.code === 4403) {
          sock.retryAt = performance.now() + 30000;
          relayTold = true;
          status(e.code === 4403 ? "This account is suspended: the game cannot reach the servers."
            : "Signed out: sign in again in another tab, and the game reaches the servers again.");
          return;
        }
        if (!opened || e.code === 4429 || e.code === 1011 || e.code === 1001) {
          sock.backoff = Math.min(30000, sock.backoff ? sock.backoff * 2 : 3000);
          sock.retryAt = performance.now() + sock.backoff;
        }
      };
      return ws;
    }

    return net;
  }

  $("stageFull").addEventListener("click", () => {
    const stage = $("stage");
    if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
    $("canvas").focus();
  });

  // Esc opens the game's menu, and Ctrl+W is crouch and forward. In full screen, Chrome and Edge
  // hand such keys to the page when it asks; out of it the browser keeps them.
  document.addEventListener("fullscreenchange", () => {
    const kb = navigator.keyboard;
    if (!kb || !kb.lock) return;
    if (document.fullscreenElement) kb.lock(["Escape", "KeyW", "KeyT", "KeyN"]).catch(() => {});
    else kb.unlock();
  });

  // Leaving the page drops the player from the game server at once: the engine's own disconnect goes out over the
  // relay before the page goes, where the server would otherwise hold a frozen player until sv_timeout ran out.
  // A connection that is simply lost cannot say goodbye; the server times that player out.
  let saidGoodbye = false;
  function disconnectNow() {
    if (!mod || stopped || saidGoodbye) return;
    saidGoodbye = true;
    try { mod.ccall("Cmd_ExecuteString", null, ["string"], ["disconnect"]); } catch (e) { /* the server times the player out instead */ }
  }

  $("stageLeave").addEventListener("click", () => {
    if (mod && !stopped) {
      try { mod.ccall("Cmd_ExecuteString", null, ["string"], ["host_writeconfig"]); } catch (e) { /* the copy from the last save stands */ }
    }
    disconnectNow();
    // a moment for the disconnect to leave through the relay before the page goes
    setTimeout(goHome, 200);
  });

  window.addEventListener("beforeunload", (e) => {
    if (!started || stopped || leaving) return;
    saveConfig(false);
    e.preventDefault();
    e.returnValue = "";
  });
  window.addEventListener("pagehide", () => {
    disconnectNow();
    saveConfig(false);
  });

  // An error in the game's own code ends its main loop: say so instead of leaving a frozen picture.
  window.addEventListener("error", (e) => {
    if (!started || stopped) return;
    const msg = String(e.message || "");
    if ((typeof WebAssembly === "object" && e.error instanceof WebAssembly.RuntimeError) || /RuntimeError|unreachable|out of bounds/.test(msg)) {
      stop("The game stopped: " + msg + ".");
    }
  });

  init();
})();
