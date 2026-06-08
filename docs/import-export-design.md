# Import And Export Design

## Goal

Add a local backup and migration workflow for the two user-owned libraries:

```text
question pool <-> export file <-> question pool
card library  <-> export file <-> card library
```

The feature must preserve the current local-first architecture. It should not add a database, auth, a build step, cloud storage, or a frontend framework.

## Current State

Export is not currently supported.

The app already has import-like behavior for manual articles and extracted questions, but that is not a full data restore flow:

- `POST /api/questions/import` imports extracted question payloads, not backup files.
- `GET /api/questions` can list the question pool.
- `GET /api/cards` can list the card library.
- There is no API that exports a bundle.
- There is no API that imports a bundle and merges it into existing local data.

Relevant storage layout:

```text
data/questions/question_pool.json
data/cards/index.json
data/cards/<id>.json
```

## Product Decision

Build one explicit "Data Import / Export" workflow rather than overloading the existing question extraction import.

The user-facing model should be:

1. Export: choose what to export, then download one JSON file.
2. Import: choose a JSON file, preview what it contains, then choose merge behavior per detected library.
3. Apply: the server validates, deduplicates, writes deterministic JSON, and returns a clear summary.

## Scope

In scope:

- Export all supported data.
- Export only the question pool.
- Export only the card library.
- Import a file that contains either or both libraries.
- Auto-detect whether the file contains questions, cards, or both.
- If imported questions are detected and local questions already exist, ask whether to replace or append.
- If imported cards are detected and local cards already exist, ask whether to replace or append.
- Validate all imported `QuestionRecord` and `CardRecord` entries using the existing domain validators.
- Deduplicate during append.
- Report added, replaced, skipped, invalid, and duplicate counts.

Not in scope for the first implementation:

- Articles, attempts, scores, crawl cursors, settings, LLM debug logs, or `.env`.
- ZIP archives.
- Partial card dependencies such as attempts and scores.
- Cross-device sync.
- Automatic scheduled backups.
- Importing arbitrary legacy shapes beyond the bundle shape described below.

## Export Format

Use a versioned JSON envelope:

```json
{
  "schema": "interview-training-workbench.backup",
  "version": 1,
  "exportedAt": "2026-06-08T00:00:00.000Z",
  "sections": {
    "questions": {
      "items": []
    },
    "cards": {
      "items": []
    }
  }
}
```

Rules:

- `schema` and `version` identify this as a backup file.
- `sections.questions` is omitted when questions are not exported.
- `sections.cards` is omitted when cards are not exported.
- `items` contain full records in their current domain shape.
- Export should not include local absolute paths.
- Export should not include `.env`, LLM keys, debug logs, or runtime server logs.

## Export API

Add:

```text
GET /api/export?scope=all
GET /api/export?scope=questions
GET /api/export?scope=cards
```

Response:

- `200 application/json`
- `content-disposition: attachment; filename="interview-workbench-backup-YYYYMMDD-HHMMSS.json"`

Invalid scope:

- `400 EXPORT_SCOPE_INVALID`

Implementation notes:

- Read through `questionStore.list()` and `cardStore.listIndex()` / `cardStore.getById()`.
- Validate records as stores already do while reading.
- Sort only if existing store order is ambiguous. Preserve question pool order and card index order by default.

## Import API

Use a two-step flow so the UI can ask the overwrite/append questions after detection.

### Preview

```text
POST /api/import/preview
```

Request:

```json
{
  "bundle": {}
}
```

Response:

```json
{
  "detected": {
    "questions": true,
    "cards": true
  },
  "local": {
    "questions": 12,
    "cards": 5
  },
  "incoming": {
    "questions": 8,
    "cards": 3
  },
  "requiresDecision": {
    "questions": true,
    "cards": true
  },
  "validation": {
    "questions": { "valid": 8, "invalid": 0 },
    "cards": { "valid": 3, "invalid": 0 }
  }
}
```

Preview must not write any files.

### Apply

```text
POST /api/import/apply
```

Request:

```json
{
  "bundle": {},
  "mode": {
    "questions": "append",
    "cards": "replace"
  }
}
```

Allowed modes:

- `append`
- `replace`
- `skip`

Response:

```json
{
  "questions": {
    "mode": "append",
    "before": 12,
    "incoming": 8,
    "after": 19,
    "added": 7,
    "replaced": 0,
    "duplicates": 1,
    "invalid": 0
  },
  "cards": {
    "mode": "replace",
    "before": 5,
    "incoming": 3,
    "after": 3,
    "added": 3,
    "replaced": 5,
    "duplicates": 0,
    "invalid": 0
  }
}
```

## Import Detection

The first implementation should recognize only the versioned backup envelope.

Detection rules:

- Questions are present when `sections.questions.items` is an array.
- Cards are present when `sections.cards.items` is an array.
- Missing sections mean "not included", not "empty replace".
- Empty included sections are valid and should preview as `incoming: 0`.

Reject:

- Non-object payloads.
- Missing or unsupported `schema`.
- Unsupported `version`.
- Sections with non-array `items`.
- Records that fail domain validation.

## Merge And Deduplication

### Questions

Replace mode:

- The final question pool is exactly the valid incoming questions.
- Existing questions are removed from the question pool.
- Duplicate incoming questions collapse to one record.

Append mode:

- Existing questions remain.
- Incoming duplicates are collapsed before merge.
- If an incoming question duplicates an existing question, keep one question only.
- Prefer the incoming record when the duplicate key matches an existing record, because imports are commonly used to restore a newer backup.

Question duplicate key:

1. Prefer exact `id` match.
2. Otherwise use normalized semantic key:

```text
lowercase(trim(question)) + "|" + lowercase(trim(category)) + "|" + lowercase(trim(query))
```

Rationale: current generated question ids are content-derived in normal flows, but the import path should still catch duplicates when ids differ across versions or sources.

### Cards

Replace mode:

- The final card library is exactly the valid incoming cards.
- `cards/index.json` is rebuilt from incoming card order.
- Existing card files not present in the incoming library should be removed by the store-level replacement operation.

Append mode:

- Existing cards remain unless a duplicate incoming card is found.
- If an incoming card duplicates an existing card, the incoming card wins.
- Rebuild `cards/index.json` without duplicate filenames.
- New or replaced imported cards should appear before older untouched cards, preserving incoming order.

Card duplicate key:

1. Prefer exact `id` match.
2. Otherwise use normalized semantic key:

```text
lowercase(trim(question)) + "|" + lowercase(trim(myAnswer))
```

Rationale: card ids are usually derived from question ids, but a card is practically the same review asset when both the prompt and saved answer match.

## Storage Changes Needed

Question store currently supports `list`, `add`, `update`, `remove`, and `removeWhere`. Add focused bulk operations instead of making the API handler mutate raw files:

- `questionStore.replaceAll(records)`
- `questionStore.merge(records, { preferIncoming: true })`

Card store currently supports `save`, `getById`, and `listIndex`. Add:

- `cardStore.list()`
- `cardStore.replaceAll(records)`
- `cardStore.merge(records, { preferIncoming: true })`

These store methods should own:

- Existing domain validation.
- Deterministic two-space JSON writes.
- Atomic-ish temp-file rename behavior.
- Card index rebuild.
- Removing stale card files during replace.

## UI Flow

Add a compact data management panel to the existing workbench UI.

Export controls:

- Segmented choice: `全部`, `题目库`, `卡片库`.
- Primary button: `导出`.
- Status text with exported counts.

Import controls:

- File picker accepting `.json`.
- Preview button or automatic preview after file selection.
- Detected-section summary:
  - "包含题目库：N 条"
  - "包含卡片库：N 张"
- For each detected section with existing local records:
  - radio choice: `追加并去重`
  - radio choice: `覆盖当前库`
  - optional `跳过`
- Apply button disabled until required choices are made.
- Result summary after import.

The UI should not show overwrite/append choices for sections that are absent from the import file.

## Error And Rescue Map

| Error | User Sees | Rescue |
| --- | --- | --- |
| File is not JSON | "导入失败：文件不是有效 JSON" | No write occurs; user can choose another file. |
| Unsupported schema/version | "导入失败：不是支持的备份文件" | No write occurs; future migrations can add version support. |
| Bundle contains invalid questions/cards | Preview shows invalid count and details | Apply is blocked until invalid records are removed or importer supports partial import. |
| User chooses append and duplicates exist | Result shows duplicates and replacement count | Incoming records win for duplicate keys. |
| Import apply partially fails | Error response and existing data remains as much as possible | Store-level replace/merge should prepare final data before writing. |
| Card replace leaves old files behind | Old cards still appear later | `cardStore.replaceAll` must rebuild index and remove stale card files. |

Critical gap to avoid: do not write questions first and cards second without a clear partial-failure story. For v1, each section may be applied independently, but each section write must be all-or-nothing from the user's perspective.

## Security And Privacy

- Treat import files as untrusted input.
- Enforce a maximum request size consistent with `readJsonBody` limits, or add an import-specific limit before accepting large backups.
- Do not execute, render as HTML, or eval imported content.
- Keep imported text as text.
- Do not export secrets from `.env` or settings containing API keys.
- The feature is local-only; no network is required.

## Tests

Focused tests:

- Export all includes questions and cards.
- Export questions omits cards.
- Export cards omits questions.
- Preview detects questions only, cards only, and both.
- Preview rejects unsupported schema/version.
- Preview reports invalid records without writing.
- Apply replace questions overwrites existing pool.
- Apply append questions deduplicates by id and semantic key.
- Apply replace cards rebuilds index and removes stale card files.
- Apply append cards lets imported duplicate cards win.
- Apply skip leaves a detected section unchanged.

Frontend tests:

- Export scope choice maps to the correct URL.
- Import preview shows only detected sections.
- Existing local library triggers overwrite/append choice.
- Apply button stays disabled until required choices are selected.
- Import result summary is visible and does not overflow on small screens.

## Implementation Sequence

1. Add `src/domain/backup.js` with bundle validation, detection, normalization, and duplicate-key helpers.
2. Add bulk methods to `questionStore` and `cardStore`.
3. Add `src/api/importExport.js` with export, preview, and apply handlers.
4. Wire routes in `server.js`.
5. Add API and storage tests.
6. Add frontend controls in `public/index.html`, `public/app.js`, and `public/styles.css`.
7. Add e2e tests for the import/export panel.
8. Update README API and feature lists.

## CEO Review Summary

Mode: SELECTIVE EXPANSION.

Scope proposals:

- Proposed: 3.
- Accepted into this document: versioned backup envelope, preview-before-apply, store-level bulk operations.
- Deferred: exporting articles/attempts/scores/settings, ZIP archives, scheduled backups.

Review findings:

- Architecture: OK. The feature fits existing API/domain/storage boundaries.
- Error handling: WARNING. Import apply needs section-level all-or-nothing writes.
- Security: OK if import remains JSON-only and secrets are never exported.
- Data flow: WARNING. Existing `POST /api/questions/import` must not be reused for backup restore.
- Code quality: OK. A dedicated domain helper keeps dedup logic out of route handlers.
- Tests: WARNING. Card replace must test stale file removal, not only index rebuild.
- Performance: OK for bounded local libraries.
- Observability: OK if preview/apply summaries include counts and validation errors.
- Rollout: OK. This can ship behind a new panel without disturbing the existing practice loop.
- Long-term trajectory: OK. Versioned envelope gives future migration room.
- Design/UX: WARNING. The UI must ask decisions only for detected sections, otherwise import will feel more dangerous than it is.

## Implementation Decisions

1. Invalid records block apply for the affected backup file. Preview reports invalid counts and errors; no write occurs until the file is valid.
2. `data/settings.json` is not part of v1 export, even with key redaction.
3. Append mode prefers incoming duplicate records for both questions and cards.
4. The first implementation recognizes only the versioned backup envelope.
5. Export/import is implemented through `GET /api/export`, `POST /api/import/preview`, and `POST /api/import/apply`.
