# TS New Music Radar

A private, single-user release tracker with a provider-neutral watchlist and canonical feed. Active adapters are Spotify, MusicBrainz, and MockProvider. The application has no playback.

## Local Setup

Requirements: Node.js 22+, pnpm 11, and Docker Desktop with Compose v2.

```powershell
Copy-Item .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate
pnpm scan -- --provider mock
pnpm dev -- --hostname 127.0.0.1
```

Open `http://127.0.0.1:3000`. Mock mode works without provider credentials.

For real providers, configure Spotify and MusicBrainz as described in [provider registration](docs/provider-registration.md), connect Spotify from Settings, approve the followed-artist import preview, map canonical artists to MusicBrainz, and run `pnpm scan`.

## Verification

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm db:up
pnpm db:migrate
pnpm test:integration
pnpm build
pnpm test:e2e
git diff --check
```

See [local development](docs/local-development.md), [architecture](docs/architecture.md), and [provider capabilities](docs/provider-capabilities.md).
