# Agent and reminder connector contracts

Glassboard's hosted browser writes bounded rows to `planning_requests`, `agent_runs`, and `email_reminder_queue`. It never calls Ollama, Hermes, SMTP, or localhost directly. A separately deployed trusted worker may poll or subscribe using server-side credentials kept outside this repository.

## Worker contract

Required environment:

- `GLASSBOARD_CONNECTOR_ENDPOINT`: HTTPS worker endpoint.
- `GLASSBOARD_CONNECTOR_KIND`: `hermes` or `ollama`.
- Supabase server credentials supplied by the deployment secret store, never `VITE_*` variables.

Validate configuration with:

```sh
GLASSBOARD_CONNECTOR_ENDPOINT=https://worker.example.com \
GLASSBOARD_CONNECTOR_KIND=hermes \
node scripts/connector-contract.mjs
```

The worker claims queued rows, records every transition in `agent_events`, and writes only structured `result`/`error` fields. Any external side effect must transition to `awaiting_approval`; only an authenticated approval command may resume it. Retry creates or reuses a bounded idempotency key. Cancelled runs are terminal.

Email workers claim `email_reminder_queue` rows whose `available_at` is due, cap attempts at 10, and set `sent`, `failed`, or `cancelled`. Do not put email addresses or provider credentials in queue payloads; resolve recipients server-side from the user id.
