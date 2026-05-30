# Garage Inventory

Small self-hosted web app for tracking household and garage consumables: screws,
nuts, batteries, tape, glue, electrical parts, and other things that tend to
disappear exactly when needed.

## Features

- Password-protected web interface.
- Card-based inventory view.
- Add, edit, and delete inventory items.
- Track quantity, unit, category, storage location, minimum stock, and notes.
- Search by name, category, location, QR/barcode, project, or note.
- Filter by category.
- Filter by project or kit.
- Filter by storage location.
- Sort by name, stock level, quantity, location, or recent updates.
- Show only items that need restocking.
- Quick quantity actions with configurable per-item step values.
- Undo for recent stock changes and deletes.
- Operation history for additions, write-offs, creates, and manual quantity edits.
- Long-lived per-item operation history in the edit drawer.
- Item or package photos stored directly with the item.
- Client-side photo compression before saving.
- QR/barcode text field for quick lookup.
- Browser camera scanning for QR and supported barcodes when available.
- Multiple storage locations per item.
- Storage location and project editors for bulk rename/delete.
- Card and compact list inventory views.
- Printable shopping list for low-stock items.
- Light and dark themes.
- SQLite storage with no external database server.

## Stack

- React
- TypeScript
- Vite
- Express
- Node.js built-in `node:sqlite`

Node.js 24 or newer is required because the backend uses `node:sqlite`.

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

The app listens on the port from `.env`, for example:

```text
http://192.168.1.82:8782
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
| `PORT` | No | `8782` | HTTP port for the Express server. |
| `GARAGE_PASSWORD` | Yes | - | Password required to enter the app. |

## Notes

This project is intended for a trusted home network or VPN. If exposing it to the
public internet, put it behind HTTPS and consider adding stronger authentication.
