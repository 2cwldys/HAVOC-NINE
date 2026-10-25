# Havoc9.org — Static Archive Site

Dystopian visual style matched to the provided helmet + group imagery.

## Files
- `index.html` — single-page site
- `styles.css` — full theme (black / deep purple / harsh orange)
- `script.js` — nav + scroll behavior
- `h9helmet_glitch.gif` — pixel logo
- `mainmenu.png` — hero background

## How to run locally
Open `index.html` in a browser, or serve the folder:

```bash
npx serve .
# or
python3 -m http.server 8080
```

## Deploy
Drop the entire folder contents onto any static host (Netlify, Cloudflare Pages, GitHub Pages, Vercel, etc.). Point the domain `havoc9.org` at the host.

## Style notes
- Palette pulled from the art: near-black backgrounds, `#ff4d00` orange accents, gritty vignette + scanlines.
- Typography: Orbitron (display), Share Tech Mono (UI), Rajdhani (body).
- Helmet is rendered with `image-rendering: pixelated` to keep the pixel-art look.
