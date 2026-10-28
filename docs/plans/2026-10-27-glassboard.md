# Glassboard Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build and verify a production-minded, responsive Trello-style React application backed by Supabase, with no fake production persistence and an explicit setup experience when backend configuration is absent.

**Architecture:** A Vite React/TypeScript SPA uses domain services and a repository interface so production always talks to Supabase while deterministic in-memory fixtures are injected only by tests. Supabase SQL owns normalized persistence, authorization, ordering, realtime, and attachment storage. Feature-focused React components share a glass design system and accessible interaction primitives.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind CSS, Framer Motion, Lucide, dnd-kit, React Router, Supabase JS, Vitest/RTL, Playwright, ESLint.

---

### Task 1: Establish the tested application shell

**Objective:** Configure Vite, strict TypeScript, Tailwind, linting, Vitest/RTL, Playwright, environment validation, and deployment metadata.

**Files:** `package.json`, Vite/TypeScript/Tailwind/ESLint configs, `src/main.tsx`, `src/App.tsx`, `src/index.css`, test setup, `.env.example`, `netlify.toml`.

1. Write a failing setup-state render test and run it.
2. Implement typed environment validation and the accessible setup screen.
3. Run the focused test and then all tests.
4. Commit the verified foundation.

### Task 2: Define domain contracts and test-only repository

**Objective:** Model workspaces, boards, lists, cards, details, filters, notifications, settings, analytics, and undoable mutations independently from transport.

**Files:** `src/types/*`, `src/data/*`, `src/test/*`, focused unit tests.

1. Write failing tests for derived analytics, filtering/search, ordering, and undo/redo.
2. Add minimal pure domain utilities and repository contracts.
3. Add an in-memory adapter only under test-support code; never select it in production.
4. Run focused and full suites; commit.

### Task 3: Build production Supabase boundary and schema

**Objective:** Implement auth and typed CRUD/reordering/realtime/storage operations and a normalized, RLS-secured migration.

**Files:** `src/lib/supabase.ts`, `src/data/supabaseRepository.ts`, `supabase/migrations/20261027000000_glassboard.sql`, tests.

1. Write failing contract tests with a boundary fake.
2. Implement Supabase client/session wiring and repository operations with surfaced errors.
3. Define tables, constraints, indexes, RLS policies, helper functions, realtime publication, and private attachment bucket policies.
4. Run tests and static SQL assertions; commit.

### Task 4: Implement premium responsive shell and reusable glass components

**Objective:** Deliver the scenic dark-glass UI, navigation, sidebar, reusable panels/cards/modal/buttons, responsive behavior, and reduced-motion handling.

**Files:** `src/components/ui/*`, `src/components/layout/*`, `src/index.css`, component tests.

1. Write failing accessibility and navigation tests.
2. Implement reusable primitives and responsive application shell.
3. Verify keyboard/focus behavior and reduced motion.
4. Run tests and commit.

### Task 5: Implement boards, lists, cards, and persistence

**Objective:** Support workspace/board/list/card CRUD, favorites, recents, templates, backgrounds, collapsible lists, and persisted drag/drop ordering.

**Files:** `src/features/boards/*`, state/provider hooks, tests.

1. Add failing integration tests for creation, editing, deletion, collapsing, favorite toggling, and reorder commands.
2. Implement mutation flows against the repository and optimistic UI with rollback errors.
3. Add dnd-kit pointer/keyboard sensors and persisted fractional ordering.
4. Run tests and commit.

### Task 6: Implement detailed card workspace

**Objective:** Provide an editable card modal for description, labels, priority, members, dates, reminders, checklists, attachments, comments/activity, custom fields, and dependencies.

**Files:** `src/features/cards/*`, tests.

1. Write failing tests for each editable card detail and accessible modal behavior.
2. Implement detail sections and repository-backed mutations.
3. Ensure attachment actions use private Supabase Storage signed URLs and clear errors.
4. Run tests and commit.

### Task 7: Implement alternate views and productivity features

**Objective:** Add board/table/calendar/timeline/dashboard views, analytics, global search/filtering, notifications/inbox/settings, shortcuts, and undo/redo.

**Files:** `src/features/views/*`, `src/features/search/*`, `src/features/productivity/*`, tests.

1. Write failing tests for view switching, derived aggregates, filters, shortcut dispatch, and undo/redo.
2. Implement route-backed views and productivity surfaces with real repository data.
3. Ensure empty/loading/error states are actionable rather than inert.
4. Run tests and commit.

### Task 8: Documentation and end-to-end verification

**Objective:** Make local Supabase setup and deployment reproducible, then run every quality gate.

**Files:** `README.md`, Playwright specs, any final fixes.

1. Write a Playwright happy path that injects the test adapter only in the test build.
2. Document configuration, schema application, commands, architecture, security, and deployment.
3. Run unit/integration tests, Playwright, lint, TypeScript, production build, and dependency audit.
4. Review the diff for secrets, unsafe HTML, inert controls, and production fallback persistence; fix regressions.
5. Commit final verified integration.