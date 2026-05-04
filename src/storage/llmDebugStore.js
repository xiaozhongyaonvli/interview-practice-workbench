// LlmDebugStore — append-only sink for raw LLM exchanges so a malformed
// response can be inspected later. CEO review red-line: validation failures
// must be visible AND preserve the original payload.
//
// Layout: <baseDir>/llm/<phase>_results.jsonl
//   phase ∈ { "extraction", "scoring" }  (Step 9 will add "scoring")
//
// Each record is a tiny envelope, NOT the parsed payload, so we can capture
// what arrived even when JSON.parse fails.

import { join } from "node:path";
import { StorageError } from "../domain/errors.js";
import { appendJsonlRecord } from "./jsonlStore.js";

const ALLOWED_PHASES = new Set(["extraction", "scoring"]);

export function createLlmDebugStore({ baseDir }) {
  if (typeof baseDir !== "string" || baseDir.length === 0) {
    throw new StorageError("baseDir is required", { code: "STORE_CONFIG_INVALID" });
  }

  function pathFor(phase) {
    if (!ALLOWED_PHASES.has(phase)) {
      throw new StorageError(`unknown llm phase "${phase}"`, {
        code: "LLM_PHASE_UNKNOWN"
      });
    }
    return join(baseDir, "llm", `${phase}_results.jsonl`);
  }

  return {
    async appendRaw({ phase, requestMeta, rawResponse, parsed = null, error = null, recordedAt = new Date().toISOString() }) {
      const envelope = {
        recordedAt,
        phase,
        requestMeta: requestMeta ?? null,
        rawResponse: typeof rawResponse === "string" ? rawResponse : JSON.stringify(rawResponse),
        parsed,
        error: error ? { code: error.code ?? null, message: error.message ?? String(error), path: error.path ?? null } : null
      };
      await appendJsonlRecord(pathFor(phase), envelope);
      return envelope;
    },

    async readPhase(phase) {
      const { readJsonlRecords } = await import("./jsonlStore.js");
      return await readJsonlRecords(pathFor(phase));
    }
  };
}
