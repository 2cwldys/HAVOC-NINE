# havoc9.org -- the site

The pages and assets of https://havoc9.org/: the front page and a page for each of PLAY, SERVERS,
DOWNLOADS, FORUM, COMMUNITIES, LADDER, MEDIA, MUSEUM, JOIN, CREDITS, LINK A GAME, ACCOUNT and ADMIN,
with their scripts, styles and pictures, and the web client's page. They are plain files. The accounts,
the forum, the admin panel and the web client's relay are h9web (the folder beside this one), which the
pages call at `/api/` and `/webclient/relay`.

## Files
- `index.html`, `styles.css`, `script.js` -- the front page, the theme (black / deep purple / harsh
  orange) and the nav + scroll behavior
- `play/`, `servers/`, `downloads/`, `forum/`, `community/`, `ladder/`, `media/`, `museum/`, `join/`,
  `credits/`, `link/`, `account/`, `admin/` -- one folder for each page
- `assets/` -- the pages' scripts, styles and pictures
- `webclient/` -- the web client's page and loader (H9XASH in the browser); its `DEPLOY.txt` covers the
  web server rules and the web client's files
- `deploy/` -- the nginx and certificate scripts of a Linux host; never served
- `h9helmet_glitch.gif` -- pixel logo; `mainmenu.png` -- hero background

## How it is served
On a host, nginx (Linux) or Caddy (Windows) serves these files over HTTPS and passes `/api/` and
`/webclient/relay` on to h9web, and `/serverlist/` on to the H9 server list. The host package
(`make-vps-package.cmd`) and its setup scripts (`vps/`) put all of it in place.

On your own PC h9web serves these files itself, on one port, from this folder. From the root of the
checkout:

    node h9web/bin/local-site.js --port 8090

(`h9web/local-site.cmd` does the same and opens the browser.) The pages call h9web for accounts, the
forum and PLAY, so try them through the local site rather than from the disk.

Building, launching and updating the whole site is in `docs/WEBSITE.txt`.

## Style notes
- Dystopian visual style matched to the helmet + group imagery.
- Palette pulled from the art: near-black backgrounds, `#ff4d00` orange accents, gritty vignette + scanlines.
- Typography: Orbitron (display), Share Tech Mono (UI), Rajdhani (body).
- Helmet is rendered with `image-rendering: pixelated` to keep the pixel-art look.
