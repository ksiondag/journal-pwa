# Journal PWA

A pen-first digital journal that installs as a native-feeling app on your touchscreen laptop. Drawings sync to a self-hosted server backed by SQLite.

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

## Running locally

```bash
npm install
node server.js
# Open http://localhost:3000
```

Create an account:
```bash
node create-user.js
```

## Deploying with nginx + Let's Encrypt

These steps assume Arch Linux, a domain already pointed at the server, and the repo cloned to `/home/rory/Projects/journal-pwa`.

### 1. Install dependencies

```bash
sudo pacman -S nginx certbot certbot-nginx nodejs npm
npm install --omit=dev
```

### 2. Create an account

```bash
node create-user.js
```

### 3. Install the systemd service

```bash
sudo cp deploy/journal-pwa.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now journal-pwa
sudo systemctl status journal-pwa   # should show "active (running)"
```

### 4. Install the nginx config

```bash
sudo ln -s /home/rory/Projects/journal-pwa/deploy/journal.ksionda.me /etc/nginx/conf.d/journal.ksionda.me.conf
sudo nginx -t && sudo systemctl reload nginx
```

### 5. Get a TLS certificate

```bash
sudo certbot --nginx -d journal.ksionda.me
```

Certbot verifies domain ownership over HTTP, issues the cert, patches the nginx config, and installs an auto-renewal timer.

The app is now live at `https://journal.ksionda.me`.

### Updating

```bash
git pull
sudo systemctl restart journal-pwa
```

## File structure

```
journal-pwa/
├── server.js        # Express server (auth, API, static files)
├── app.js           # Client-side canvas + sync logic
├── index.html       # Main app shell
├── login.html       # Login page
├── style.css
├── manifest.json    # PWA metadata
├── sw.js            # Service worker
├── journal.db       # SQLite database (created on first run)
├── create-user.js   # CLI to add users
└── deploy/
    ├── journal-pwa.service          # systemd unit
    └── journal.ksionda.me.nginx     # nginx server block
```
