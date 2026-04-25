# Timeline

**Timeline** is a pre-alpha iPhone-first PWA for visualizing a lifespan from birthdate to today. It is intentionally soft, bubbly, and tactile rather than calendar-like.

Current version: **v0.11.0-prealpha**

## What is included

- First-time setup wizard
- Birthdate → today lifespan visualization
- `Now`, `Timeline`, `Distance`, and `Vault` tabs
- Theme system
  - **Liquid Glass** default theme
  - **Aero** theme inspired by Frutiger Aero / late-2000s Aqua skeuomorphism
- Procedural bubbles, shine, caustics, and Aero leaf accents
- IndexedDB local persistence with localStorage fallback
- Manual JSON export/import
- Version snapshots, including optional daily auto snapshots
- Offline-ready service worker
- Installable PWA manifest
- iPhone safe-area support

## Install on iPhone

1. Host the repository with GitHub Pages.
2. Open the GitHub Pages URL in Safari on iPhone.
3. Tap **Share**.
4. Tap **Add to Home Screen**.
5. Launch **Timeline** from the home screen.

## Data safety

Timeline is local-first. Your data is stored in browser storage using IndexedDB. This is convenient and private, but it is not a sacred vault carved into a mountain. Use **Vault → Export JSON** to keep real backups in Files, iCloud, or another safe place.

## Development

No build step is required. This is a static app.

```txt
index.html
styles/app.css
src/app.js
manifest.webmanifest
service-worker.js
assets/icons/*.svg
```

Open `index.html` directly for quick inspection, or serve the folder locally for service worker testing.

```bash
python3 -m http.server 8080
```

Then open:

```txt
http://localhost:8080
```

## Version notes

### v0.11.0-prealpha

Initial functional pre-alpha. The app focuses on a polished core loop: setup, visualize lifespan, compare distances, switch themes, save locally, and export/restore data.
