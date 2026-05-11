# AGENTS.md

This file is the project-specific guide for Codex and other code agents. Claude Code usually reads `CLAUDE.md`; Codex conventionally looks for `AGENTS.md`, so this repository uses `AGENTS.md` as the single agent guide.

## Project Snapshot

Interview Training Workbench is a local-first interview practice app:

```text
topic -> article -> question -> answer -> score -> retry -> save as card
```

The app has no database, no auth layer, and no required cloud dependency for the core workflow. Runtime state is stored on local disk under `data/` as JSON / JSONL.

## Stack

- Node.js `>= 22`
- Native Node HTTP server in `server.js`
- ES modules (`"type": "module"`)
- Vanilla frontend in `public/`
- Tests use Node's built-in test runner and `jsdom`
- Optional LLM calls through GPT-compatible environment variables

## Important Directories

- `server.js` - app server, route wiring, static file serving, `.env` loading
- `public/` - browser UI (`index.html`, `styles.css`, `app.js`)
- `src/api/` - HTTP route handlers
- `src/domain/` - schemas, validation, domain helpers
- `src/storage/` - JSON / JSONL persistence stores
- `src/llm/` - prompt provider, model clients, LLM evaluation service
- `src/sources/` - external source adapters, currently NowCoder
- `prompts/` - prompt templates used by LLM features
- `scripts/` - operational/evaluation scripts
- `tests/` - unit, schema, API, and e2e tests
- `data/` - local runtime state; treat as generated/user data
- `design/` - design exploration artifacts

## Commands

Install dependencies:

```powershell
npm install
```

Start the app:

```powershell
npm start
```

Default URL:

```text
http://127.0.0.1:8000/
```

Override host or port:

```powershell
$env:PORT=18000
$env:HOST="127.0.0.1"
npm start
```

Run tests:

```powershell
npm test
npm run test:schema
npm run test:e2e
```

Focused tests are commonly run with Node directly, for example:

```powershell
node --test tests/api-questions.test.js
node --test tests/e2e/live-frontend.test.js
```

## Environment

Copy `.env.example` to `.env` for local LLM configuration. Never commit real keys.

Relevant variables:

- `LLM_API_KEY`
- `LLM_BASE_URL`
- `LLM_MODEL`
- `LLM_API_STYLE`
- `LLM_REASONING_EFFORT`
- `NOWCODER_ARTICLE_TTL_DAYS`
- `PORT`
- `HOST`
- `DATA_DIR`

When `LLM_API_KEY` is missing, manual workflows still work and LLM routes return `LLM_NOT_CONFIGURED`.

## Persistence Rules

- Production/runtime data lives under `data/`.
- `data/` content is local state and should not be casually edited or committed.
- Tests that touch storage should pass a temporary `baseDir`; see `tests/helpers/withServer.js`.
- Attempts and scores are append-only by design.
- Cards should be created through `POST /api/cards/from-attempt`.
- Invalid LLM output is preserved in `data/llm/` for debugging.

## API Surface

Core routes:

- `GET /health`
- `POST /api/articles/manual`
- `GET /api/articles`
- `POST /api/questions/import`
- `POST /api/questions/extract`
- `GET /api/questions`
- `PATCH /api/questions/:id`
- `POST /api/questions/purge-ignored`
- `POST /api/attempts`
- `GET /api/attempts`
- `DELETE /api/attempts/:id`
- `POST /api/attempts/:id/score`
- `POST /api/attempts/:id/llm-score`
- `POST /api/cards/from-attempt`
- `GET /api/cards`
- `POST /api/sources/nowcoder/fetch`

## Development Guidance

- Preserve the local-first architecture. Do not introduce a database, ORM, auth system, build step, or frontend framework unless explicitly requested.
- Follow existing boundaries: validation and domain rules in `src/domain/`, route behavior in `src/api/`, persistence in `src/storage/`, model/provider logic in `src/llm/`.
- Keep server construction injectable. Tests rely on `createAppServer` / `startServer` accepting injected `baseDir`, adapters, and services.
- Prefer structured schema/domain helpers over ad hoc object mutation in route handlers.
- Keep JSON and JSONL storage readable and deterministic. Existing JSON writes use two-space formatting and temporary-file rename behavior.
- Avoid touching generated runtime logs such as `server-*.log` unless the task is specifically about logs.
- Do not overwrite user data in `.env` or `data/`.

## Testing Guidance

- For API/storage/domain changes, add or update focused tests near the touched behavior.
- For schema changes, update `tests/schema/`.
- For frontend workflow changes, update or run relevant `tests/e2e/` coverage.
- When adding server tests, use random ports through `withServer` and pass a temp `baseDir` for routes that write state.
- For NowCoder behavior, prefer mocked adapters in tests rather than live network calls.

## Frontend Guidance

- The frontend is a workbench UI, not a marketing page.
- Keep interactions dense, predictable, and task-oriented.
- Maintain compatibility with the existing vanilla HTML/CSS/JS structure.
- Be careful with persistent UI state in `localStorage` and `location.hash`; the app restores active partition, view, and practice question.
- Ensure text does not overflow controls on small screens.

## Current Product Behavior To Preserve

- NowCoder fetch is fixed at 2 articles per request.
- Same-day repeated fetches advance with a per-day cursor.
- Cross-day fetches restart from offset 0 while URL dedup prevents duplicate saved articles.
- Ignored questions are hidden by default and can be purged in bulk.
- Saving a question as a card removes it from the active practice pool.

