// API tests for /api/cards/from-attempt and /api/cards.

import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withServer } from "./helpers/withServer.js";

async function makeBase() {
  return await mkdtemp(join(tmpdir(), "itw-api-cards-"));
}

const summary = {
  scores: {
    technicalCorrectness: 8,
    coverageCompleteness: 7,
    logicalStructure: 8,
    expressionClarity: 7,
    interviewPerformance: 7
  },
  overallComment: "良好",
  primaryTechnicalGap: "...",
  primaryExpressionGap: "...",
  engineeringMindsetGap: "...",
  retryInstruction: "...",
  highScoreAnswer: {
    basic: "基础高分回答",
    advanced: "进阶高分回答"
  },
  interviewerReview: {
    firstImpression: "第一印象",
    willFollowUp: true,
    followUpReason: "追问原因",
    answerType: "回答类型",
    unprofessionalSignals: ["信号"]
  },
  expressionAnalysis: {
    mece: { conclusion: "MECE", duplicateExpressions: [], missingKeyPoints: [], structureCompleteness: "完整" },
    structure: { conclusion: "结构", topDown: "是", clearPoints: "清楚", wanderingProblem: "无" },
    scqa: { situation: "S", complication: "C", question: "Q", answer: "A", problems: [] },
    sentenceIssues: []
  },
  technicalAnalysis: {
    errors: [],
    misunderstandings: [],
    shallowParts: [],
    missingKnowledge: ["执行计划"],
    shouldExpand: []
  },
  expressionComparison: {
    original: "原回答",
    optimized: "优化表达",
    keyChanges: ["先总后分"]
  },
  essence: {
    examIntent: "考察意图",
    questionType: "工程实践",
    importance: "重要性"
  },
  followUpQuestions: [
    { question: "追问", whyAsk: "原因", answerHint: "提示" }
  ],
  longTermAdvice: {
    commonProblems: ["常见问题"],
    expressionHabits: ["表达习惯"],
    experiencedEngineerTips: ["资深建议"],
    finalCoreGoal: "核心目标"
  }
};

const extraction = {
  questions: [
    {
      question: "线上慢 SQL 怎么排查?",
      category: "MySQL",
      difficulty: "medium",
      evidence: "面试官提到慢日志",
      confidence: 0.86
    }
  ]
};

async function seedFullChain(baseUrl) {
  // 1. import a question
  await fetch(`${baseUrl}/api/questions/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "mysql", source: "manual", extraction })
  });
  const list = await (
    await fetch(`${baseUrl}/api/questions?query=mysql`)
  ).json();
  const question = list.questions[0];

  // 2. answer
  const attempt = await (
    await fetch(`${baseUrl}/api/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: question.id, answer: "我会先看慢查询日志..." })
    })
  ).json();

  // 3. score
  await fetch(`${baseUrl}/api/attempts/${attempt.attemptId}/score`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ summary })
  });

  return { question, attempt };
}

test("POST /api/cards/from-attempt creates a CardRecord and writes cards/<id>.json + index.json", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const { attempt } = await seedFullChain(baseUrl);

      const response = await fetch(`${baseUrl}/api/cards/from-attempt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: attempt.attemptId,
          category: "MySQL",
          difficulty: "medium"
        })
      });
      assert.equal(response.status, 201);
      const card = await response.json();
      assert.equal(card.category, "MySQL");
      assert.equal(card.difficulty, "medium");
      assert.equal(card.feedbackPromptVersion, "interview-coach-v2");
      assert.equal(card.feedback.performanceScore.scores.technicalCorrectness, 8);
      assert.equal(card.feedback.engineeringMindsetGap, summary.engineeringMindsetGap);
      assert.equal(card.feedback.highScoreAnswer.advanced, "进阶高分回答");
      assert.equal(card.feedback.essence.examIntent, "考察意图");
      assert.equal(card.feedback.longTermAdvice.finalCoreGoal, "核心目标");

      // Files exist on disk
      const onDisk = JSON.parse(
        await readFile(join(baseDir, "cards", `${card.id}.json`), "utf8")
      );
      assert.equal(onDisk.id, card.id);

      const index = JSON.parse(
        await readFile(join(baseDir, "cards", "index.json"), "utf8")
      );
      assert.ok(index.includes(`${card.id}.json`));
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/cards/from-attempt accepts Chinese difficulty and normalizes to medium", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const { attempt } = await seedFullChain(baseUrl);
      const response = await fetch(`${baseUrl}/api/cards/from-attempt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: attempt.attemptId,
          category: "MySQL",
          difficulty: "中等"
        })
      });
      assert.equal(response.status, 201);
      const card = await response.json();
      assert.equal(card.difficulty, "medium");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/cards/from-attempt rejects unscored attempts", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      // Seed only attempt, no score.
      await fetch(`${baseUrl}/api/questions/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "mysql", source: "manual", extraction })
      });
      const list = await (
        await fetch(`${baseUrl}/api/questions?query=mysql`)
      ).json();
      const attempt = await (
        await fetch(`${baseUrl}/api/attempts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId: list.questions[0].id, answer: "x" })
        })
      ).json();

      const response = await fetch(`${baseUrl}/api/cards/from-attempt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: attempt.attemptId,
          category: "MySQL",
          difficulty: "medium"
        })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "ATTEMPT_NOT_SCORED");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/cards/from-attempt rejects unknown category", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const { attempt } = await seedFullChain(baseUrl);
      const response = await fetch(`${baseUrl}/api/cards/from-attempt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: attempt.attemptId,
          category: "前端",
          difficulty: "medium"
        })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.path, "category");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/cards/from-attempt rejects duplicate card without overwrite, accepts with overwrite=true", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const { attempt } = await seedFullChain(baseUrl);

      const r1 = await fetch(`${baseUrl}/api/cards/from-attempt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: attempt.attemptId,
          category: "MySQL",
          difficulty: "medium"
        })
      });
      assert.equal(r1.status, 201);

      const r2 = await fetch(`${baseUrl}/api/cards/from-attempt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: attempt.attemptId,
          category: "MySQL",
          difficulty: "medium"
        })
      });
      assert.equal(r2.status, 400);
      const dup = await r2.json();
      assert.equal(dup.code, "CARD_DUPLICATE_ID");

      const r3 = await fetch(`${baseUrl}/api/cards/from-attempt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: attempt.attemptId,
          category: "MySQL",
          difficulty: "medium",
          overwrite: true
        })
      });
      assert.equal(r3.status, 201);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("GET /api/cards lists saved cards", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const { attempt } = await seedFullChain(baseUrl);
      await fetch(`${baseUrl}/api/cards/from-attempt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: attempt.attemptId,
          category: "MySQL",
          difficulty: "medium"
        })
      });

      const list = await (await fetch(`${baseUrl}/api/cards`)).json();
      assert.equal(Array.isArray(list.cards), true);
      assert.equal(list.cards.length, 1);
      assert.equal(list.cards[0].category, "MySQL");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("GET /api/cards on a fresh project returns an empty list", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const list = await (await fetch(`${baseUrl}/api/cards`)).json();
      assert.deepEqual(list.cards, []);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/cards/from-attempt 4xxs for an unknown attemptId", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/cards/from-attempt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: "no-such-attempt",
          category: "MySQL",
          difficulty: "medium"
        })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "ATTEMPT_NOT_FOUND");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
