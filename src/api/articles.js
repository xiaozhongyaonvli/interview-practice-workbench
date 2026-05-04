// Article API — HTTP routes for ArticleRecord, currently scoped to manual
// paste only. NowCoder fetch joins in Step 8 via a separate adapter.
//
// Design notes:
// - The store is injected so tests can swap a tmp directory in.
// - id generation lives here, not in the store, so storage stays unaware
//   of business rules (one source contributes one id-prefix style).
// - All errors are translated to HTTP responses by sendError so route
//   handlers stay free of try/catch boilerplate.

import { ValidationError } from "../domain/errors.js";
import { readJsonBody, sendJson, sendError } from "./http.js";

const SAFE_QUERY = /^[A-Za-z0-9_-]{1,64}$/;

function nowIso() {
  return new Date().toISOString();
}

function randomSuffix() {
  // 8 hex chars is plenty for human-scale paste rates.
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

function generateManualArticleId(query) {
  const safeQuery = SAFE_QUERY.test(query) ? query : "default";
  const stamp = Date.now().toString(36);
  return `manual-${safeQuery}-${stamp}-${randomSuffix()}`;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`, {
      code: "ARTICLE_INPUT_INVALID",
      path: field
    });
  }
}

export function createArticleApi({ articleStore, now = nowIso }) {
  if (!articleStore) {
    throw new Error("createArticleApi: articleStore is required");
  }

  async function handleCreateManual(req, res) {
    try {
      const body = await readJsonBody(req);
      requireString(body.query, "query");
      requireString(body.title, "title");
      requireString(body.text, "text");

      // Re-validate the query character set so a hostile client cannot
      // smuggle path separators through the article store's safeQueryName
      // fallback.
      if (!SAFE_QUERY.test(body.query)) {
        throw new ValidationError("query must contain only A-Za-z0-9_-", {
          code: "ARTICLE_INPUT_INVALID",
          path: "query"
        });
      }

      const record = {
        id: generateManualArticleId(body.query),
        source: "manual",
        query: body.query,
        title: body.title.trim(),
        text: body.text,
        fetchedAt: now()
      };

      const saved = await articleStore.append(record);
      sendJson(res, 201, saved);
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handleList(req, res, url) {
    try {
      const query = url.searchParams.get("query");
      requireString(query, "query");
      const records = await articleStore.listByQuery(query);
      sendJson(res, 200, { articles: records });
    } catch (err) {
      sendError(res, err);
    }
  }

  return { handleCreateManual, handleList };
}
