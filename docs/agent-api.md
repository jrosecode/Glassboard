# Glassboard AI-agent API

Glassboard provides a user-scoped API at:

`https://atjaxxsvrqehjrtrqpzd.supabase.co/functions/v1/agent-api`

The deployed Edge Function requires a **Supabase Auth user access token** in `Authorization: Bearer <jwt>` and the project's **publishable (anon) key** in the `apikey` header. It checks the current user through Supabase Auth and performs all operations through that user's RLS-scoped database client. It never uses a service-role key. Use a dedicated team account with access only to the boards an agent should manage.

## Actions

| Method | Path | Purpose |
|---|---|---|
| GET | /health | Worker online/offline, queued/running counts visible to the user |
| GET | /boards | Authorized boards, max 100 |
| GET | /boards/:id/lists | Authorized lists |
| GET | /boards/:id/cards?limit=100&offset=0&since=ISO_DATE | Paginated cards, optional incremental changes |
| GET | /boards/:id/runs | Recent agent runs |
| POST | /boards/:id/cards | Create a card with `list_id`, `title`, optional `description`, `priority`, `position` |
| PATCH | /cards/:id | Update allowed fields: `title`, `description`, `priority`, `completed`, `due_at`, `is_archived` |
| POST | /cards/:id/move | Move to a normal list on the same board using `list_id` and `position` |
| POST | /cards/:id/queue | Queue an AI run with `idempotency_key` (maximum 120 characters) |

Responses use JSON. A missing or expired JWT receives 401. Actions still enforce board membership and database row-level security. Query parameters are bounded, with at most 200 cards per page. The changes endpoint does **not** return deletion tombstones; for reliable reconciliation, perform periodic full refreshes, and de-duplicate updated cards by ID.

## Hermes / agent client

The repo contains `scripts/glassboard-agent-client.mjs`, a Node 22+ client with **no extra dependencies**. Set these in the agent's secure environment (not in GitHub or browser source):

- `SUPABASE_URL`: your Glassboard Supabase project URL
- `SUPABASE_ANON_KEY`: project publishable/anon key (safe to expose, but still configure RLS)
- `GLASSBOARD_ACCESS_TOKEN`: an active Supabase user session JWT, **or** `GLASSBOARD_EMAIL` and `GLASSBOARD_PASSWORD` for a dedicated agent user

Examples:

```bash
node scripts/glassboard-agent-client.mjs health
node scripts/glassboard-agent-client.mjs boards
node scripts/glassboard-agent-client.mjs lists <board-id>
node scripts/glassboard-agent-client.mjs cards <board-id>
node scripts/glassboard-agent-client.mjs update <card-id> '{"completed":true}'
node scripts/glassboard-agent-client.mjs move <card-id> <list-id> 2
node scripts/glassboard-agent-client.mjs queue <card-id> stable-job-id
```

Never provide a Supabase service-role key to an agent making ordinary card CRUD requests. Keep access tokens private, rotate credentials, and do not log passwords or session tokens.

## Background AI execution

The browser queues work in the database, but the queue is not an AI model or a hosted worker. Running `scripts/productivity-worker.mjs` requires a **persistent server or computer** with:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (server-side only; this worker calls restricted administrative queue RPCs)
- `OLLAMA_URL` pointing to a reachable Ollama instance
- `OLLAMA_MODEL` matching an installed model, for example `qwen3:4b`

Run `node scripts/productivity-worker.mjs --once` for a one-pass diagnostic or omit `--once` for a continuously running worker. Use a service manager to restart it on failure. The worker checks `/api/tags` before claiming a task and sends a heartbeat to Supabase approximately every 30 seconds. When its model is unavailable, it leaves queued jobs unclaimed rather than failing them repeatedly.

**A worker is considered online only after a recent healthy heartbeat.** Check `GET /health` for `workerOnline`, `queuedRuns`, `runningRuns`, and `oldestQueuedAt`. A 200 response from the agent API does not imply worker execution is online.

Queue jobs are protected by existing leases, retry backoff, idempotency keys, and approval gates. The agent's output is a proposed result; do not assume suggested changes have been applied unless the workflow explicitly approves them.

## Smoke test

1. Authenticate as a user with board access.
2. GET `/health` and `/boards`; verify the board appears.
3. GET `/boards/:id/lists`; choose a normal list.
4. Create a harmless test card, update its completion status, move it, then archive it.
5. Confirm the changes appear in the Glassboard UI.
6. Queue a **separate test task** and confirm its run transitions from `queued` to `running` and `awaiting_approval` only when an active worker is connected.
7. Verify an unauthenticated call receives 401, and an unrelated user cannot read or modify the board.

Tests 1–5 validate the API and authorization, while step 6 validates the external worker. Keep these distinctions in deployment reports.
