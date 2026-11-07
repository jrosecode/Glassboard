# Glassboard AI 2.0: Cloud and Local Models

## Current implementation

Glassboard now has **Settings → AI Providers & Models**. Per-user preferences are RLS-protected in `public.ai_user_settings`. Encrypted provider API credentials use **Supabase Vault**; the browser may submit a new API key securely but cannot read back stored keys. The worker obtains a saved key through the service-role-only `ai_worker_provider_key` RPC, then sends requests to an allowlisted provider endpoint. A worker configured with its own provider API keys is also supported.

The worker is model-independent, handles Ollama and LM Studio locally, and supports cloud APIs for OpenAI, Moonshot/Kimi, Z.ai/GLM, OpenRouter and Anthropic. Provider/model choice and fallback settings are loaded for the *requesting user* for each queued AI run. API keys are not returned by any browser endpoint.

**This is the first operational release of the architecture, not a finished million-user platform.** The existing SQL lease queue remains; migration to Supabase Queues, tenant-level quotas, horizontal worker autoscaling, interactive external tool execution, local device enrollment, centralized cost catalog, cancellation, and Stripe billing are follow-up work. Jobs still produce proposed changes and require approval where applicable.

## Initial configuration

On the computer or server running the worker:

```bash
git pull
npm ci
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in a private environment
npm run worker:productivity
```

Never put `SUPABASE_SERVICE_ROLE_KEY`, any provider keys, or private passwords in `VITE_*` variables, GitHub, or browser code.

### Provider server configuration (optional when using BYOK)

| Provider | Environment variable | Model examples |
|---|---|---|
| Moonshot / Kimi | `MOONSHOT_API_KEY` | `kimi-k3`, `kimi-k2.6` |
| Z.ai / GLM | `ZAI_API_KEY` | `glm-4.7`, `glm-4.5` |
| OpenAI | `OPENAI_API_KEY` | `gpt-4.1-mini`, `gpt-4.1` |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` |
| OpenRouter | `OPENROUTER_API_KEY` | Model IDs as offered by OpenRouter |
| Ollama | `OLLAMA_URL`, default `http://127.0.0.1:11434` | Installed model IDs, e.g. `qwen3:4b` |
| LM Studio | `LMSTUDIO_URL`, default `http://127.0.0.1:1234` | Installed model ID |

Provider models and availability change. The model IDs shown in Settings are presets, not a live availability guarantee. A worker must be online; saving settings does **not** start a worker. Local inference servers should remain private on the same host or trusted network. **Do not port-forward Ollama or LM Studio directly to the internet.**

### Bring Your Own Key

1. Open **Settings → AI Providers & Models**.
2. Select your cloud provider.
3. Under **API connections**, paste its provider API key and click **Save encrypted key**.
4. Select the model and click **Save AI settings**.
5. Verify **Worker online** and assign a card to AI.

Keys are stored in Supabase Vault using user-linked secret references, never in `ai_user_settings`. Authenticated browser callers can save or revoke only their own keys. Only service-role workers can decrypt. Revocation removes the linked Vault secret. Choosing a different provider never copies a saved key.

### Local model example

Start Ollama locally on the worker computer. Install a model, then select **Ollama → qwen3:4b** in Settings. Enable **Local-only processing** to disable fallback to cloud providers. You must still have a persistent Glassboard worker running on that computer.

### What runs automatically

The worker polls existing leased `agent_runs` and `planning_requests`, loads the requesting user's model preferences, enforces the personal monthly run cap, performs inference, records a usage event, validates JSON, and completes or fails the run through the existing RPCs. Leases prevent concurrent consumers from claiming the same work. If its model server is offline and no cloud capability is available, the worker leaves queued jobs alone and reports offline.

`ai_usage_events` records token counts returned by providers (if available) and duration, but **pricing has not been configured**. Currency estimates should not be considered verified billing. Failed or malformed responses may need separate accounting. This is not a subscription billing quota or an atomic cross-worker credit system.

Fallback occurs only when enabled, the alternative provider has credentials, and the job is **not** set to local-only. When fallback is disabled, a failed model call follows the existing worker retry/failure policy.

### Important deployment limitations

- Supabase/Netlify host the UI and database but **not** the persistent model-running worker. Run and supervise it separately.
- This release supports controlled *model inference and proposed results*, not arbitrary external tool execution or autonomous browsing. Do not grant unrestricted external permissions to a model.
- The existing lease-backed database queue works for an initial worker pool. Dedicated Supabase Queues and autoscaling are next steps for high throughput.
- Per-user limits are personal safeguards. Before charging users, add centrally enforced workspace quotas, rate limits, reserved credits, token pricing, circuit breakers, and transactional metering.
- Validate every provider's supported JSON-mode parameters and model IDs with live integration tests before enabling that combination in production.
- Local models are processed only by an explicitly configured worker; a separately authenticated consumer-device enrollment flow is not implemented.
- Do not claim end-to-end execution until a live persistent worker connects with a configured provider and completes a test card.

## Acceptance checklist

- [ ] Connect a persistent worker.
- [ ] Save a key in Vault or configure a server-side cloud key.
- [ ] Run the same authorized test job through Kimi, GLM, and Ollama.
- [ ] Verify fallback behavior and confirm local-only jobs never use cloud.
- [ ] Verify RLS isolation for two independent user accounts.
- [ ] Verify a worker restart preserves the run and does not duplicate approvals.
- [ ] Verify usage events and provider invoices match.
- [ ] Stress-test concurrency and deploy workspace quotas before paid launch.
