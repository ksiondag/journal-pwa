# Journal PWA

A pen-first digital journal that installs as a native-feeling app on your touchscreen laptop.

## Quick Start (2 minutes)

You need a local HTTPS server for the PWA install prompt to appear.
The easiest option is `npx serve` or Python's built-in server:

### Option A — Node (recommended)
```bash
npx serve .
# Open http://localhost:3000 in Chrome/Edge
```

### Option B — Python
```bash
python3 -m http.server 8080
# Open http://localhost:8080 in Chrome/Edge
```

### Option C — VS Code
Install the "Live Server" extension, right-click `index.html` → Open with Live Server.

## Installing as a PWA

1. Open in **Chrome** or **Edge** on your touchscreen laptop
2. Look for the **install icon** (⊕) in the address bar, or go to Menu → "Install Journal"
3. Click Install — it appears in your Start menu and taskbar
4. Launch it like any app — it runs fullscreen with no browser chrome

> **Note:** PWA install requires either HTTPS or localhost. The app works on localhost without any certificates.

## Controls

| Input | Action |
|-------|--------|
| **Pen / stylus** | Draw on the page |
| **Finger swipe left** | Next page |
| **Finger swipe right** | Previous page |
| **Arrow buttons** | Navigate pages |
| **← → arrow keys** | Navigate pages |
| `P` | Switch to Pen |
| `E` | Switch to Eraser |
| `H` | Switch to Highlighter |

## Storage

All drawings are saved automatically to **IndexedDB** in your browser — no server needed, fully local. Export individual pages as PNG using the download button.

## File Structure

```
journal-pwa/
├── index.html      # The entire app (single file)
├── manifest.json   # PWA metadata (name, icons, display mode)
├── sw.js           # Service worker (offline caching)
└── icons/
    ├── icon-192.png
    └── icon-512.png
```
# journal-pwa
