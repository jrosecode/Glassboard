# Glassboard

A production-minded Trello-style workspace with a responsive glass interface, Supabase authentication and persistence, real-time-ready board data, private attachments, alternate planning views, analytics, search, keyboard controls, and undo/redo.

## Stack

- React 19, TypeScript, Vite, Tailwind CSS 4
- Framer Motion, Lucide, dnd-kit, React Router
- Supabase Auth, Postgres, Realtime, and Storage
- Vitest + React Testing Library; Playwright

## Local setup

Requirements: Node 22+ and a Supabase project. The checked-in migration targets ordinary Supabase Postgres and does not contain credentials.

```bash
npm install
cp .env.example .env.local
# Replace the placeholder with the project's publishable/anon key
npx supabase link --project-ref atjaxxsvrqehjrtrqpzd
npx supabase db push
npm run dev
```

Environment variables:

```dotenv
VITE_SUPABASE_URL=https://atjaxxsvrqehjrtrqpzd.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable-anon-key>
```

If either variable is missing, Glassboard intentionally renders an actionable setup screen. It never silently writes production data to local storage. The seeded board is available only through the explicit `testMode` dependency used by Vitest or under Vite's `test` mode with `?test=1` for Playwright.

Enable an email auth provider and add local/deployed origins to Supabase Auth redirect URLs. The migration creates profiles, workspaces, memberships, boards, lists, cards, labels, checklists, comments, attachments, custom fields, dependencies, activity, notifications, settings, indexes, row-level security, Realtime publication entries, and a private `attachments` bucket.

## Commands

```bash
npm run dev        # development server
npm test           # unit/integration tests
npm run typecheck  # strict TypeScript
npm run lint       # ESLint
npm run build      # production bundle
npm run e2e        # Playwright happy path
```

Install the browser once if needed: `npx playwright install chromium`.

## Architecture and security

`src/supabase.ts` is the production data boundary. UI code receives seeded state only when `testMode` is explicitly true; the production entry point enables that flag only when Vite runs in `test` mode and the URL requests it. Mutations in a configured session are sent to Supabase and errors are surfaced instead of being replaced with fake success.

The SQL migration uses workspace membership helpers and RLS on every application table. Attachment objects are private, size/type restricted, board-authorized by the card ID at the first storage-path segment, and owned deletes are enforced. Never use the service-role key in this client application.

## Product controls

- `⌘/Ctrl + K`: focus global search
- `⌘/Ctrl + Z`: undo
- `⌘/Ctrl + Shift + Z`: redo
- `Escape`: close the active modal
- Drag cards with pointer or keyboard; list and card ordering is persisted
- Board, table, calendar, timeline, and dashboard views share the same card state

## Deployment

`netlify.toml` builds `dist` and sends SPA routes to `index.html`. Configure both `VITE_SUPABASE_*` variables in the Netlify environment and add the deployed origin to Supabase Auth redirects before building. No deployment is performed by this repository.
