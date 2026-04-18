# Picks Browser

NBA props workflow app with:

- Vite + React frontend
- Express backend
- split bankroll tracking for Sleeper / PrizePicks
- multi-day slate loading
- AI player and game-roster research
- queue, entry builder, journal, and persistent app state

## Local development

```bash
npm install
npm run dev
```

Frontend runs through Vite and proxies `/api` to the Express server during local development.

## Environment variables

Copy `.env.example` to `.env` for local development.

Important variables:

- `OPENAI_API_KEY`
- `BALLDONTLIE_API_KEY`
- `ODDS_API_KEY`
- `BLOB_READ_WRITE_TOKEN`
- `VERCEL_BLOB_STATE_PATH`

## Persistence model

This app uses two storage modes:

- Local development: falls back to `server/data/app-state.json`
- Vercel: uses Vercel Blob when `BLOB_READ_WRITE_TOKEN` is present

That means you can keep the current local JSON workflow, but production state on Vercel should live in Blob.

## Deploying to Vercel

1. Create a Vercel project for this app.
2. Create a Vercel Blob store and connect it to the project.
3. Add these environment variables in Vercel:
   - `OPENAI_API_KEY`
   - `BALLDONTLIE_API_KEY`
   - `ODDS_API_KEY` if you want provider auto-fill
   - `BLOB_READ_WRITE_TOKEN`
   - `VERCEL_BLOB_STATE_PATH=state/app-state.json`
4. Deploy.

The frontend builds to `dist`, and `/api/*` is rewritten to the Express-powered Vercel function in `api/index.js`.
