# Interview Training Workbench

A local-first interview practice workbench for fetching interview posts, extracting questions, scoring answers, and saving review cards.

## What It Does

This project turns the following loop into a browser-based local application:

```text
topic -> article -> question -> answer -> score -> retry -> save as card
```

All runtime data is stored on local disk with JSON / JSONL files. There is no database, no login flow, and no cloud dependency for the core workflow.

## Core Features

- Import manual interview articles
- Fetch interview posts from NowCoder
- Extract questions into a local question pool
- Save multiple answer attempts per question
- Score attempts with pasted JSON or a live LLM call
- Compare retries and keep the best attempt
- Save strong attempts as long-lived review cards
- Persist question pool, attempts, scores, cards, and fetch cursors locally

## Current Fetch And Persistence Behavior

- NowCoder fetch is fixed at 2 articles per request
- Same-day repeated fetches advance with a per-day cursor
- Cross-day fetches restart from offset 0, while URL dedup still prevents re-saving old articles
- Ignored questions are hidden by default and can be purged in bulk
- Saving a question as a card removes it from the active practice pool
- The frontend restores the last active partition, view, and practice question with `localStorage` and `location.hash`

## Getting Started

Requirements:

- Node.js `>= 22`

Install dependencies:

```powershell
npm install
```

Start the server:

```powershell
npm start
```

Then open:

```text
http://127.0.0.1:8000/
```

Override host / port if needed:

```powershell
$env:PORT=18000
$env:HOST="127.0.0.1"
npm start
```

## LLM Setup

LLM-powered extraction and scoring are optional.

Create a local env file:

```powershell
Copy-Item .env.example .env
```

Then set:

```text
DEEPSEEK_API_KEY=your_key_here
```

When `DEEPSEEK_API_KEY` is present, the app enables:

- `POST /api/questions/extract`
- `POST /api/attempts/:id/llm-score`
- title-level interview classification during NowCoder fetch

Without a key, the manual paste workflows still work.

## Data Storage

Runtime data is stored under `data/` and is intentionally not committed:

- `data/articles/`
- `data/questions/`
- `data/attempts/`
- `data/scores/`
- `data/cards/`
- `data/llm/`
- `data/crawl-cursors/`

## Project Structure

```text
public/         frontend (vanilla HTML/CSS/JS)
src/api/        HTTP route handlers
src/domain/     domain schema and validation rules
src/llm/        prompt provider, LLM client, evaluation services
src/sources/    external source adapters (NowCoder)
src/storage/    JSON / JSONL persistence
scripts/        helper scripts
tests/          unit, schema, and e2e tests
data/           local runtime state (gitignored)
```

## Test Commands

```powershell
npm test
npm run test:schema
npm run test:e2e
```

## API Overview

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
- `POST /api/attempts/:id/score`
- `POST /api/attempts/:id/llm-score`
- `POST /api/cards/from-attempt`
- `GET /api/cards`
- `POST /api/sources/nowcoder/fetch`

## Engineering Constraints

- No database / ORM
- No authentication system
- Attempts and scores are append-only
- Cards are only written through `POST /api/cards/from-attempt`
- Invalid LLM output is preserved in `data/llm/` for debugging instead of being silently dropped

