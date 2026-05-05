# Interview Training Workbench

A local-first interview training workbench. Phase A turns the loop

```text
topic -> article -> question -> answer -> score -> retry -> save card
```

into a working browser app backed by JSON / JSONL files — no database, no
login, no cloud.

## Run

```powershell
node server.js
```

Then open <http://127.0.0.1:8000/>.

The default port and host can be overridden:

```powershell
$env:PORT=18000; $env:HOST="127.0.0.1"; node server.js
```

## LLM (optional)

Real LLM calls are disabled until you supply a DeepSeek API key. Manual
paste lanes work without it.

```powershell
copy .env.example .env
# edit .env and set DEEPSEEK_API_KEY=sk-...
```

The server reads `DEEPSEEK_API_KEY` at startup. Loading happens via
`process.env`, so set it in your shell or use a `.env` loader of your
choice (`.env` itself is gitignored).

## Tests

```powershell
npm test            # unit + integration suite
npm run test:e2e    # browser-side jsdom suite
npm run test:schema # record schemas
```

All three must pass before progressing between Phase A steps. See
`docs/phase-a-implementation-plan.md` (in the parent project) for the gate.

## Layout

```text
public/         frontend (vanilla HTML/CSS/JS, no bundler)
src/domain/    record schemas + domain rules
src/storage/   JSON/JSONL stores per record type
src/sources/   external data adapters (NowCoder)
src/llm/       prompt provider + DeepSeek client + evaluation service
src/api/       HTTP route handlers
prompts/       LLM prompt templates (extraction, interview-coach-v2)
data/          runtime state (gitignored)
tests/         unit + e2e + schema suites
```

## Phase A status

All nine steps in `docs/phase-a-implementation-plan.md` are complete:

| Step | Topic | API surface |
|------|-------|-------------|
| 0 | Skeleton + view switching | `/health`, static |
| 1 | Domain models + storage | — |
| 2 | Manual article import | `POST /api/articles/manual`, `GET /api/articles` |
| 3 | Extraction JSON paste | `POST /api/questions/import`, `GET /api/questions`, `PATCH /api/questions/:id` |
| 4 | Answer attempts | `POST /api/attempts`, `GET /api/attempts?questionId=` |
| 5 | Scoring JSON paste | `POST /api/attempts/:id/score` |
| 6 | Retry + best attempt | (frontend computation) |
| 7 | Save as card | `POST /api/cards/from-attempt`, `GET /api/cards` |
| 8 | NowCoder fetch | `POST /api/sources/nowcoder/fetch` |
| 9 | Real LLM | `POST /api/questions/extract`, `POST /api/attempts/:id/llm-score` |
