import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withServer } from "./helpers/withServer.js";

async function makeBase() {
  return await mkdtemp(join(tmpdir(), "itw-api-scoring-card-retry-"));
}

const validSummary = {
  scores: {
    technicalCorrectness: 7,
    coverageCompleteness: 6,
    logicalStructure: 7,
    expressionClarity: 7,
    interviewPerformance: 6
  },
  overallComment: "acceptable",
  primaryTechnicalGap: "missing lock wait details",
  primaryExpressionGap: "structure is loose",
  engineeringMindsetGap: "missing verification loop",
  retryInstruction: "answer by discovery, location, analysis, verification"
};

test("POST /api/attempts/:id/llm-score falls back to saved card when the source question was removed", async () => {
  const baseDir = await makeBase();
  try {
    const llmService = {
      scoreAnswer: async ({ question, answer, context }) => {
        assert.equal(question, "线上慢 SQL 怎么排查?");
        assert.equal(answer, "second version from card retry");
        assert.match(context, /verify before rollout/);
        return { summary: validSummary };
      }
    };

    await withServer(async (baseUrl) => {
      const importResponse = await fetch(`${baseUrl}/api/questions/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "mysql",
          source: "manual",
          extraction: {
            questions: [
              {
                question: "线上慢 SQL 怎么排查?",
                category: "MySQL",
                difficulty: "medium",
                evidence: "slow sql",
                confidence: 0.9
              }
            ]
          }
        })
      });
      assert.equal(importResponse.status, 200);

      const list = await (await fetch(`${baseUrl}/api/questions`)).json();
      const question = list.questions[0];

      const firstAttempt = await (
        await fetch(`${baseUrl}/api/attempts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId: question.id, answer: "first version" })
        })
      ).json();

      const scoreResponse = await fetch(`${baseUrl}/api/attempts/${firstAttempt.attemptId}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          summary: {
            ...validSummary,
            retryInstruction: "verify before rollout"
          }
        })
      });
      assert.equal(scoreResponse.status, 201);

      const cardResponse = await fetch(`${baseUrl}/api/cards/from-attempt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: firstAttempt.attemptId,
          category: "MySQL",
          difficulty: "medium"
        })
      });
      assert.equal(cardResponse.status, 201);

      const secondAttempt = await (
        await fetch(`${baseUrl}/api/attempts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            questionId: question.id,
            answer: "second version from card retry"
          })
        })
      ).json();

      const llmResponse = await fetch(
        `${baseUrl}/api/attempts/${secondAttempt.attemptId}/llm-score`,
        { method: "POST" }
      );
      assert.equal(llmResponse.status, 201);
      const body = await llmResponse.json();
      assert.equal(body.attemptId, secondAttempt.attemptId);
      assert.equal(body.summary.overallComment, validSummary.overallComment);
    }, { baseDir, llmService });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
