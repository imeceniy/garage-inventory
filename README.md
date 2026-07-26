# Garage Inventory

[Русская версия](README.ru.md)

Small self-hosted web app for tracking household and garage consumables: screws,
nuts, batteries, tape, glue, electrical parts, and other things that tend to
disappear exactly when needed.

## Features

- Password login with an HttpOnly cookie session and login throttling.
- Dedicated stock, container, project, stocktake, and shopping workspaces.
- Compact card and list views with mobile bottom navigation.
- Create, edit, soft-delete, and fully restore inventory items.
- Typo-tolerant synonym search and domain filters.
- Fast operations from an explicit default storage balance.
- Undo without losing the item identity or balance distribution.
- Unified journal for receipts, deductions, transfers, and stocktakes.
- Cursor-ready global and per-item history.
- Item dialog with overview, balances, history, and editing tabs.
- Browser-compressed photos and thumbnails stored outside SQLite.
- QR/barcode scanning and generation over HTTPS.
- Per-location and per-container balances with transfers.
- Normalized locations, tags, and many-to-many projects.
- Step-by-step balance stocktakes applied only when a session closes.
- Separate reorder points and target stock levels.
- Printable shopping list calculated up to target stock.
- Light and dark themes.
- SQLite storage with no external database server.

## Stack

- React
- TypeScript
- Vite
- Express
- Node.js built-in `node:sqlite`

Node.js 24 or newer is required because the backend uses `node:sqlite`.

## Architecture

- `src/api` contains the typed HTTP client.
- `src/components` contains workspaces, dialogs, and domain controls.
- `src/domain` contains inventory types and constants.
- `server/repositories` performs batched SQLite reads without N+1 queries.
- `server/services` owns transactional domain behavior.
- `server/routes` isolates authentication and file HTTP concerns.
- `server/database.mjs` owns ordered migrations and backups.

`stock_balances` is the source of truth for quantities and physical locations.
The total on `items` is maintained transactionally as a query cache. Projects
and tags use normalized many-to-many relations.

## Local Setup

Install dependencies:

```bash
npm install
```

Create an environment file:

```bash
cp .env.example .env
```

Edit `.env` and set a real password:

```env
PORT=8782
HTTPS_PORT=8783
HTTPS_KEY=certs/garage.key
HTTPS_CERT=certs/garage.crt
GARAGE_PASSWORD=change-me
```

Build the frontend:

```bash
npm run build
```

Start the app:

```bash
npm start
```

Open:

```text
http://localhost:8782
```

## Development

Run the backend and Vite dev server together:

```bash
npm run dev
```

The Vite dev server proxies `/api` requests to the backend on port `8782`.

## Data Storage

The SQLite database is created automatically at:

```text
data/garage.sqlite
```

The `data/` directory is intentionally ignored by git.

Before migrations, every application start creates a consistent database copy in
`data/backups/`. The server also runs `PRAGMA integrity_check` and creates a
backup daily. The latest 14 copies are retained by default. Create a manual
backup with:

```bash
npm run backup
```

To restore, stop the app, replace `data/garage.sqlite` with a selected backup,
remove stale `garage.sqlite-wal` and `garage.sqlite-shm` files if present, then
start the process again:

```bash
pm2 stop garage-inventory
cp data/backups/garage-YYYYMMDD-HHMMSS-mmm.sqlite data/garage.sqlite
rm -f data/garage.sqlite-wal data/garage.sqlite-shm
pm2 start garage-inventory
```

Photos and thumbnails are stored outside SQLite in `data/uploads/items/`.
Existing base64 photos are migrated there automatically on first startup.

## Home Server Deployment

One simple deployment option is to keep the app in a user-owned directory on the
server:

```bash
cd ~/garage-inventory
npm ci
npm run build
npm start
```

For persistent background execution, PM2 can be used:

```bash
pm2 start npm --name garage-inventory -- start
```

The app listens on the configured ports. When HTTPS is configured, the HTTP port
permanently redirects to HTTPS:

```text
http://192.168.1.82:8782
https://192.168.1.82:8783
```

## Updating A Deployed Copy

From the deployed directory:

```bash
git pull
npm ci
npm run build
pm2 restart garage-inventory
```

## Environment Variables

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | No | `8782` | HTTP port; redirects when HTTPS is configured. |
| `HTTPS_PORT` | No | - | Optional HTTPS port. Required for camera scanning from another device. |
| `HTTPS_KEY` | No | - | Path to the HTTPS private key, relative to the project root. |
| `HTTPS_CERT` | No | - | Path to the HTTPS certificate, relative to the project root. |
| `GARAGE_PASSWORD` | Yes | - | Password required to enter the app. |
| `GARAGE_SECURE_COOKIES` | No | Automatic | Explicit `Secure` cookie override for tests or a trusted TLS reverse proxy. |
| `BACKUP_ON_START` | No | `true` | Create a consistent SQLite copy before startup migrations. |
| `BACKUP_RETENTION` | No | `14` | Number of recent automatic backups to retain. |

## Notes

This project is intended for a trusted home network or VPN. HTTPS is required for
the secure cookie session and camera access from another device.
