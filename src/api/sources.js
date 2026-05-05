// Sources API — POST /api/sources/nowcoder/fetch.
//
// The adapter does the heavy lifting; this module translates between the
// adapter's record shape and the ArticleStore contract, and handles the
// public HTTP surface.

import { ValidationError } from "../domain/errors.js";
import { readJsonBody, sendJson, sendError } from "./http.js";

const SAFE_QUERY = /^[A-Za-z0-9_-]{1,64}$/;

function randomSuffix() {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

function generateNowCoderId(query) {
  return `nowcoder-${query}-${Date.now().toString(36)}-${randomSuffix()}`;
}

export function createSourcesApi({ nowCoderAdapter, articleStore }) {
  if (!nowCoderAdapter) throw new Error("createSourcesApi: nowCoderAdapter required");
  if (!articleStore) throw new Error("createSourcesApi: articleStore required");

  async function handleNowCoderFetch(req, res) {
    try {
      const body = await readJsonBody(req);
      if (typeof body.query !== "string" || !SAFE_QUERY.test(body.query)) {
        throw new ValidationError("query must contain only A-Za-z0-9_-", {
          code: "NOWCODER_INPUT_INVALID",
          path: "query"
        });
      }
      const maxArticles = Number.isInteger(body.maxArticles)
        ? body.maxArticles
        : 3;

      let result;
      try {
        result = await nowCoderAdapter.searchAndFetch({
          query: body.query,
          maxArticles
        });
      } catch (err) {
        // Adapter failed whole-pipeline (e.g. search page 500). Surface a
        // visible error so the UI can guide the user to the manual paste
        // fallback — not a silent empty success.
        throw err;
      }

      const saved = [];
      const failed = [];

      for (const r of result.records) {
        if (r.__error) {
          failed.push({ url: r.url, code: r.code, message: r.message });
          continue;
        }
        const record = { id: generateNowCoderId(body.query), ...r };
        try {
          await articleStore.append(record);
          saved.push(record);
        } catch (storeErr) {
          failed.push({
            url: r.sourceUrl,
            code: storeErr?.code ?? "STORE_FAILED",
            message: storeErr?.message ?? String(storeErr)
          });
        }
      }

      sendJson(res, 200, {
        searchUrl: result.searchUrl,
        discovered: result.links.length,
        saved,
        failed
      });
    } catch (err) {
      sendError(res, err);
    }
  }

  return { handleNowCoderFetch };
}
