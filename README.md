# THE NINTH DROP — Offline Store Backend

The API for the physical store (POS): staff login, billing, customers, returns, expenses, approvals, reports and audit logs.
Express + MongoDB. The POS frontend (`../store-manager`) has no database access of its own. It forwards every `/api/*` call here.

```
Browser ──► store-manager (Next.js, :3001) ──/api/*──► store-backend (Express, :4001) ──► MongoDB
```

## Data

- **Products and categories live in the `ONLINE_DB_NAME` database.**
  - If that is the **store's own** database (like the demo), the owner adds, edits and deletes categories, sub-categories and products from the POS (Categories and Products & SKUs screens).
  - If it is the **website's** database (`thenine`, or any name in `LIVE_DB_NAME`), the POS only reads them, and every catalog change is refused (403). Edit them in the online admin.
  - Deleting a category is blocked while it has sub-categories or products. A product that is on a bill is archived instead of deleted, so old bills and returns keep working.
- **Stock is shared.** A store sale takes stock from the same fields the website uses, in one atomic update, so the two can't oversell each other.
- **All POS data is in its own `pos_*` collections** in the `MONGODB_URI` database. POS staff, customers and sales never touch online users, orders or carts.
- `MONGODB_URI` and `ONLINE_DB_NAME` can name different databases, but they must be on the **same cluster**, because a sale writes the bill and the stock change in one transaction.

## Setup

```bash
npm install
cp .env.example .env      # fill in MONGODB_URI, ONLINE_DB_NAME, a long POS_JWT_SECRET, Cloudinary
npm run seed:admin        # first time only: creates the super admin (username "owner")
npm run dev               # http://localhost:4001/api  (restarts on file changes)
```

Then start the frontend in `../store-manager` (`npm run dev`, port 3001).

## Demo database (dummy products and categories)

`npm run seed:demo` fills a **separate** database (`offlinestoretheninthdrop`, or `DEMO_DB_NAME`) with dummy catalog data:
a women's clothing store with 5 main categories (Ethnic, Western, Bottom, Winter Wear, Accessories) and 16 sub-categories, plus New Arrivals. That's 40 products in sizes with stock (157 SKUs), and each sub-category has its own SKU code.
It adds no customers, bills or expenses, only one login: `owner` / `Demo@1234`, approval PIN `1234`.

- It never writes to the online store's database: `thenine` (and `LIVE_DB_NAME`) are refused.
- If the demo database already has data, it stops. `npm run seed:demo -- --reset` drops **only** the demo database and fills it again.
- To use it, `.env` points both `MONGODB_URI` (database part) and `ONLINE_DB_NAME` at the demo database. To go live, switch the two lines back to `thenine`. Both versions are in `.env`.

## Layout

| Path | What it holds |
|---|---|
| `src/server.js` | Loads `.env`, connects to MongoDB, starts the server |
| `src/app.js` | Express app: JSON/cookies, mounts every router under `/api` |
| `src/routes/*.routes.js` | Thin routes: validate → permission → service |
| `src/services/*` | Business logic (sales, returns, products, customers, ...) |
| `src/lib/*` | Models, auth, permissions, DB/transactions, stock, money, audit |

Every route checks permissions on the server through `route(handler, { permission })` in `src/lib/http.js`. A forbidden call returns 403 and writes a `FORBIDDEN_ACCESS` audit row.

## Environment variables

| Name | Purpose |
|---|---|
| `PORT` | Default 4001 (the online backend uses 5000) |
| `MONGODB_URI` | POS database. Must be a replica set (Atlas is). |
| `ONLINE_DB_NAME` | Catalog database on the same cluster (products, categories, stock). Empty = same as above. |
| `LIVE_DB_NAME` | Extra website database names (comma-separated) whose catalog must never be edited from the POS. `thenine` is always protected. |
| `POS_JWT_SECRET` | 32+ random characters, different from the online backend's secrets |
| `POS_SESSION_HOURS` | Session length, default 12 |
| `POS_COOKIE_DOMAIN` | Leave empty unless the cookie must cover a parent domain |
| `POS_PUBLIC_URL` | Public URL of the **frontend**. Used in bill QR codes and WhatsApp links. |
| `CLIENT_ORIGIN` | Only if a frontend calls this server directly instead of through its `/api` proxy |
| `CLOUDINARY_*` | Store logo and product photo uploads |
| `POS_ADMIN_*` | Used only by `npm run seed:admin` |

## Deploy

Any Node 18+ host (Render, Railway, a VPS): `npm install`, then `npm start`. Set the env vars there.
Set `POS_API_URL` on the frontend to this server's URL. Use `https` in production so the cookie is `Secure`.
The in-memory rate limits assume a single server instance.
