# TRIVO ERP — Setup Guide

## Prerequisites
- Node.js 20+
- Docker Desktop (for PostgreSQL, Redis, MinIO)
- Git

## Quick Start

### 1. Start Infrastructure
```bash
docker-compose up -d
```
Wait ~15 seconds for all containers to be healthy.

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment
```bash
cp .env.example server/.env
```
Edit `server/.env` with your settings (defaults work for local Docker setup).

### 4. Database Setup
```bash
cd server
npm run db:generate   # Generate Prisma client
npm run db:migrate    # Run migrations
npm run db:seed       # Seed initial data
```

### 5. Start Development Servers
```bash
# From project root:
npm run dev
```
- **Frontend:** http://localhost:5173
- **Backend API:** http://localhost:3001
- **MinIO Console:** http://localhost:9001 (admin/admin)
- **Prisma Studio:** Run `npm run db:studio` from `/server`

## Default Login
| Email | Password | Role |
|-------|----------|------|
| admin@sea-erp.com | Admin@123 | Super Admin |
| manager@sea-erp.com | Welcome@123 | Production Manager |

## Architecture
```
sea-erp/
├── client/           # React 18 + MUI v5 frontend
│   ├── src/
│   │   ├── pages/    # 9 module pages + Dashboard
│   │   ├── components/  # Shared UI components
│   │   ├── api/      # Axios API client with JWT refresh
│   │   ├── store/    # Zustand state (auth, UI)
│   │   ├── hooks/    # WebSocket, permissions
│   │   └── theme/    # Material Design 3 theme
│   └── vite.config.ts
│
├── server/           # Node.js + Express backend
│   ├── src/
│   │   ├── modules/  # 9 ERP modules + Auth/Hardware/Reports
│   │   ├── middleware/  # Auth, RBAC, Audit, Validate, Error
│   │   ├── shared/   # WebSocket, Hardware (RS232 scales)
│   │   └── config/   # DB, Redis, Env, Logger
│   └── prisma/
│       ├── schema.prisma  # Full 9-module database schema
│       └── seed.ts        # Initial data seeder
│
└── docker-compose.yml  # PostgreSQL + Redis + MinIO
```

## Hardware Integration

### Weighing Scales — Two Modes

| Mode | When to use | How it works |
|------|-------------|--------------|
| **Web Serial API** (preferred) | Browser runs on the same machine as the scale (shop floor tablet/laptop) | Chrome/Edge 89+ on HTTPS or `localhost` — click **Connect Scale via USB/COM** on the Hardware page; browser prompts for port selection |
| **Backend RS232** (cloud fallback) | Backend is deployed on a remote server with a USB scale attached | Register the scale as a company-owned device (Hardware page / `POST /hardware/devices`, with its COM port); readings are pushed to that company's clients only via WebSocket. (`SCALE_PORT` env was removed — a process-wide device would be shared by every company.) |

> **Why two modes?** If the backend is deployed to a cloud VM, `SerialPort` on the server cannot reach a COM port on a workshop laptop. Web Serial solves this by letting the browser read the scale locally and report the weight to the API.

### RFID / Barcode
- USB HID scanners emulate keyboard input — no driver needed, works natively in any browser text field.

## Module Coverage

> **This table is stale as of the wholesale/retail pivot** (see [CLAUDE.md](CLAUDE.md) §0) — it
> reflects the original manufacturing build, not the system's current state. For the accurate,
> up-to-date module status (what's live post-pivot vs. dormant) and the full API surface, see
> **[API.md](API.md)** § Feature Scope. Short version: modules 8–9 (Sales, Finance) plus Jewelry
> Tagging/Branches, Quality (hallmarking/repairs), and Procurement's buy-side intake are **live**;
> modules 1, 5, 6 (Design/BOM, Manufacturing, Outsourcing) and `SalesOrder` (module 4's production
> order) are **dormant** — present and untouched, not deleted, simply unused post-pivot.

## Key Technical Decisions

### Database
- **PostgreSQL 16** — ACID compliant, high concurrency, JSONB for flexible data
- **Prisma ORM** — Type-safe queries, auto-migrations, Prisma Studio GUI
- Decimal precision: 4 decimal places for weights (0.0001g), 4 for carats (0.0001ct)

### Backend
- **JWT + Refresh Tokens** — 8h access tokens, 30d refresh
- **Granular RBAC** — 35+ permissions, role-based screen visibility
- **Immutable Audit Logs** — Every update logged with user, IP, old/new values
- **WebSocket (Socket.io)** — Real-time WIP floor updates, scale readings
- **RS232 Integration** — SerialPort library for direct scale connection

### Frontend
- **Material Design 3** inspired theme — Jewelry gold (#CC8800) primary palette
- **React Query** — Automatic caching, background refetch, optimistic updates
- **Zustand** — Auth state with persistence, UI preferences
- **Vite env vars** — Client bundle only exposes `VITE_*` prefixed variables. Set `VITE_API_URL` in `client/.env` for production; leave empty for local dev (Vite proxy handles it)
- **Web Serial API** — Browser reads scale weights directly from USB/COM port; no backend relay needed for local deployments
