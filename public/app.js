// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

const views = document.querySelectorAll("[data-view]");
const navLinks = document.querySelectorAll("[data-view-link]");

function showView(name, options = {}) {
  views.forEach((view) => {
    const active = view.dataset.view === name;
    view.hidden = !active;
    view.classList.toggle("active-view", active);
  });

  navLinks.forEach((link) => {
    link.classList.toggle("active", link.dataset.viewLink === name);
  });

  if (typeof window.scrollTo === "function") {
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      // jsdom and some embedded environments throw on scrollTo. Best-effort.
    }
  }

  // Step 4: when entering the practice view from a question card, hydrate
  // the hero block + attempt history with that question's real data.
  if (name === "practice" && options.questionId) {
    setActivePracticeQuestion(options.questionId);
  }
}

document.querySelectorAll("[data-back-home]").forEach((button) => {
  button.addEventListener("click", () => showView("home"));
});

navLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showView(link.dataset.viewLink);
  });
});

// data-open-practice is now attached to dynamically-rendered question cards,
// so we use event delegation on the document to catch them post-render.
document.addEventListener("click", (event) => {
  const trigger = event.target.closest?.("[data-open-practice]");
  if (trigger) {
    const card = trigger.closest("[data-question-id]");
    const id = card?.dataset.questionId ?? null;
    showView("practice", { questionId: id });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setStatus(node, message, tone) {
  if (!node) return;
  if (!message) {
    node.hidden = true;
    node.textContent = "";
    node.removeAttribute("data-source-status-tone");
    return;
  }
  node.hidden = false;
  node.textContent = message;
  if (tone) node.dataset.sourceStatusTone = tone;
}

// ---------------------------------------------------------------------------
// Source-box tab switching (manual / nowcoder / extract)
// ---------------------------------------------------------------------------

const sourceTabs = document.querySelectorAll("[data-source-tab]");
const sourcePanels = document.querySelectorAll("[data-source-panel]");

function showSourcePanel(name) {
  sourceTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.sourceTab === name);
  });
  sourcePanels.forEach((panel) => {
    panel.hidden = panel.dataset.sourcePanel !== name;
  });
}

sourceTabs.forEach((tab) => {
  tab.addEventListener("click", () => showSourcePanel(tab.dataset.sourceTab));
});

// ---------------------------------------------------------------------------
// Step 2: manual article import
// ---------------------------------------------------------------------------

const importForm = document.getElementById("manual-import-form");
const importStatus = importForm
  ? importForm.querySelector("[data-source-status]")
  : null;

function renderImportedList(articles) {
  const list = document.querySelector("[data-imported-list]");
  if (!list) return;
  if (!Array.isArray(articles) || articles.length === 0) {
    list.innerHTML = '<li class="imported-empty">还没有导入的文章</li>';
    return;
  }
  const recent = articles.slice(-5).reverse();
  list.innerHTML = recent
    .map((article) => {
      const title = escapeHtml(article.title ?? "(无标题)");
      const fetchedAt = escapeHtml(
        String(article.fetchedAt ?? "").slice(0, 16).replace("T", " ")
      );
      const queryLabel = escapeHtml(article.query ?? "");
      return `<li data-imported-id="${escapeHtml(article.id ?? "")}">
        <strong>${title}</strong>
        <small>${fetchedAt} · ${queryLabel}</small>
      </li>`;
    })
    .join("");
}

async function refreshImportedList(query) {
  if (!query) return;
  try {
    const response = await fetch(
      `/api/articles?query=${encodeURIComponent(query)}`
    );
    if (!response.ok) {
      renderImportedList([]);
      return;
    }
    const body = await response.json();
    renderImportedList(Array.isArray(body.articles) ? body.articles : []);
  } catch (error) {
    console.warn("refreshImportedList failed", error);
  }
}

if (importForm) {
  importForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(importStatus, "", null);

    const formData = new FormData(importForm);
    const payload = {
      query: String(formData.get("query") ?? "").trim(),
      title: String(formData.get("title") ?? "").trim(),
      text: String(formData.get("text") ?? "")
    };

    if (!payload.query) return setStatus(importStatus, "方向不能为空", "error");
    if (!payload.title) return setStatus(importStatus, "标题不能为空", "error");
    if (!payload.text.trim()) return setStatus(importStatus, "正文不能为空", "error");

    try {
      const response = await fetch("/api/articles/manual", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const reason = body?.error ?? `HTTP ${response.status}`;
        setStatus(importStatus, `保存失败: ${reason}`, "error");
        return;
      }
      setStatus(importStatus, `已保存: ${body?.title ?? payload.title}`, "ok");
      const titleField = importForm.querySelector("[name=title]");
      const textField = importForm.querySelector("[name=text]");
      if (titleField) titleField.value = "";
      if (textField) textField.value = "";
      await refreshImportedList(payload.query);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      setStatus(importStatus, `保存失败: ${message}`, "error");
    }
  });
}

// ---------------------------------------------------------------------------
// Step 3: extraction import + question pool render
// ---------------------------------------------------------------------------

const extractForm = document.getElementById("extract-import-form");
const extractStatus = extractForm
  ? extractForm.querySelector("[data-source-status]")
  : null;

function renderQuestionPool(questions) {
  const grid = document.querySelector("[data-question-grid]");
  if (!grid) return;

  if (!Array.isArray(questions) || questions.length === 0) {
    grid.innerHTML = `
      <article class="training-card add-card" data-add-card>
        <strong>+</strong>
        <h4>导入抽题以填充问题池</h4>
        <p>侧栏 "导入抽题" tab 粘贴 LLM JSON,即可生成候选问题。</p>
      </article>`;
    return;
  }

  const statusLabel = (s) =>
    ({ candidate: "候选", accepted: "已练", ignored: "已忽略", duplicate: "重复", mastered: "已掌握" }[s] ?? s);

  const cards = questions.map((q) => {
    const muted = q.status === "ignored" || q.status === "duplicate";
    const klass = muted ? "training-card muted" : q.status === "mastered" ? "training-card mastered" : "training-card";
    const evidence = q.evidence
      ? escapeHtml(String(q.evidence).slice(0, 90))
      : "暂无来源片段";
    const confidencePct = Math.round((q.confidence ?? 0) * 100);
    return `<article class="${klass}" data-question-id="${escapeHtml(q.id)}">
      <div class="card-topline">
        <span>${escapeHtml(q.category)}</span>
        <em>${escapeHtml(statusLabel(q.status))}</em>
      </div>
      <h4>${escapeHtml(q.question)}</h4>
      <p>${evidence}</p>
      <div class="score-row">
        <span>难度 ${escapeHtml(q.difficulty)}</span>
        <span>置信度 ${confidencePct}%</span>
        <span>${escapeHtml(q.source ?? "")}</span>
      </div>
      <div class="card-action-row">
        <button class="primary" type="button" data-open-practice>开始练习</button>
        <button class="ghost" type="button" data-question-action="ignore">忽略</button>
      </div>
    </article>`;
  });

  // Always end with a "+ create" affordance so the grid never feels empty.
  cards.push(`
    <article class="training-card add-card" data-add-card>
      <strong>+</strong>
      <h4>继续导入抽题</h4>
      <p>粘贴更多 LLM JSON 扩展问题池。</p>
    </article>`);

  grid.innerHTML = cards.join("");
}

let lastKnownQuery = "mysql";

async function refreshQuestionPool(query) {
  if (!query) query = lastKnownQuery;
  lastKnownQuery = query;
  try {
    const response = await fetch(
      `/api/questions?query=${encodeURIComponent(query)}`
    );
    if (!response.ok) {
      renderQuestionPool([]);
      return;
    }
    const body = await response.json();
    renderQuestionPool(Array.isArray(body.questions) ? body.questions : []);
  } catch (error) {
    console.warn("refreshQuestionPool failed", error);
  }
}

if (extractForm) {
  extractForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(extractStatus, "", null);

    const formData = new FormData(extractForm);
    const query = String(formData.get("query") ?? "").trim();
    const rawResponse = String(formData.get("rawResponse") ?? "");

    if (!query) return setStatus(extractStatus, "方向不能为空", "error");
    if (!rawResponse.trim()) return setStatus(extractStatus, "抽题 JSON 不能为空", "error");

    try {
      const response = await fetch("/api/questions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query,
          source: "manual",
          rawResponse
        })
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        const reason = body?.error ?? `HTTP ${response.status}`;
        setStatus(extractStatus, `导入失败: ${reason}`, "error");
        return;
      }

      const summary = `已导入 ${body.added.length} 条 · 重复 ${body.duplicates.length} · 错误 ${body.errors.length}`;
      setStatus(extractStatus, summary, body.added.length > 0 ? "ok" : "error");
      const textField = extractForm.querySelector("[name=rawResponse]");
      if (textField) textField.value = "";
      await refreshQuestionPool(query);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      setStatus(extractStatus, `导入失败: ${message}`, "error");
    }
  });
}

// Delegated PATCH handler for the "忽略" action on each question card.
document.addEventListener("click", async (event) => {
  const target = event.target.closest?.("[data-question-action]");
  if (!target) return;
  const action = target.dataset.questionAction;
  const card = target.closest("[data-question-id]");
  const id = card?.dataset.questionId;
  if (!id) return;

  const status = action === "ignore" ? "ignored" : null;
  if (!status) return;

  // Optimistic UI: mark the card so the user sees the change instantly even
  // before the server confirms. On failure we re-render from the server.
  if (card) card.classList.add("muted");

  try {
    const response = await fetch(`/api/questions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status })
    });
    if (!response.ok) {
      console.warn("question patch failed", response.status);
    }
  } catch (error) {
    console.warn("question patch failed", error);
  }
  await refreshQuestionPool(lastKnownQuery);
});

// ---------------------------------------------------------------------------
// Initial population
// ---------------------------------------------------------------------------

const initialQuery =
  importForm?.querySelector("[name=query]")?.value?.trim() || "mysql";
lastKnownQuery = initialQuery;

// Best-effort: never throw, never block view switching.
refreshImportedList(initialQuery).catch(() => {});
refreshQuestionPool(initialQuery).catch(() => {});

// ---------------------------------------------------------------------------
// Step 4: practice-view question hydration + answer attempts
// ---------------------------------------------------------------------------

let currentQuestionId = null;
let currentQuestion = null;
let bestAttemptForSave = null;

function statusLabelZh(s) {
  return (
    {
      candidate: "候选",
      accepted: "已练",
      ignored: "已忽略",
      duplicate: "重复",
      mastered: "已掌握"
    }[s] ?? s
  );
}

async function fetchQuestionById(id) {
  // The pool fetch by `lastKnownQuery` is the natural place to find the
  // question — we do NOT add a separate /api/questions/:id endpoint just
  // for this lookup. If the user came in via a different query (e.g. they
  // changed lastKnownQuery on a fresh boot), we widen by trying with no
  // query filter as a fallback.
  try {
    const queries = [lastKnownQuery, ""];
    for (const q of queries) {
      const url = q
        ? `/api/questions?query=${encodeURIComponent(q)}`
        : "/api/questions";
      const response = await fetch(url);
      if (!response.ok) continue;
      const body = await response.json();
      const found = (body.questions ?? []).find((row) => row.id === id);
      if (found) return found;
    }
  } catch (error) {
    console.warn("fetchQuestionById failed", error);
  }
  return null;
}

function renderPracticeQuestion(q) {
  const meta = document.querySelector("[data-question-meta]");
  const title = document.querySelector("[data-question-title]");
  const source = document.querySelector("[data-question-source]");
  const quality = document.querySelector("[data-question-quality]");
  const answerInput = document.querySelector("[data-answer-input]");

  if (!q) {
    if (meta) meta.textContent = "未找到该问题";
    if (title) title.textContent = "请返回题目库重新选择";
    if (source) source.textContent = "";
    if (quality) quality.textContent = "—";
    if (answerInput) answerInput.value = "";
    return;
  }
  if (meta) {
    meta.textContent = `${q.category} · ${statusLabelZh(q.status)} · Practice Mode`;
  }
  if (title) title.textContent = q.question;
  if (source) {
    const parts = [];
    if (q.source) parts.push(`来源:${q.source}`);
    if (q.sourceTitle) parts.push(q.sourceTitle);
    if (typeof q.confidence === "number") {
      parts.push(`confidence ${(q.confidence * 100).toFixed(0)}%`);
    }
    source.textContent = parts.join(" · ") || "暂无来源";
  }
  if (quality) {
    quality.textContent = (q.confidence ?? 0) >= 0.7 ? "可练" : "需确认";
  }
  if (answerInput) answerInput.value = "";
}

async function refreshAttemptHistory(questionId) {
  const list = document.querySelector("[data-attempt-list]");
  if (!list) return;
  try {
    const response = await fetch(
      `/api/attempts?questionId=${encodeURIComponent(questionId)}`
    );
    if (!response.ok) {
      list.innerHTML = '<p class="imported-empty">读取作答历史失败。</p>';
      updateSavePreview({ question: currentQuestion, bestAttempt: null });
      return;
    }
    const body = await response.json();
    const attempts = body.attempts ?? [];
    if (attempts.length === 0) {
      list.innerHTML =
        '<p class="imported-empty">还没有作答记录。保存第一版回答后这里会出现历史。</p>';
      lastAttemptId = null;
      updateSavePreview({ question: currentQuestion, bestAttempt: null });
      return;
    }
    // Newest first; the API returns oldest-first, so reverse for display.
    const sorted = attempts.slice().reverse();
    lastAttemptId = sorted[0]?.attemptId ?? null;
    if (sorted[0]?.summary) {
      renderFeedback({ summary: sorted[0].summary });
    } else {
      clearFeedbackCard();
    }

    // Step 6/7: identify the best-scoring attempt across the list and
    // compute a per-attempt delta vs its predecessor.
    const bestAttempt = selectBestAttemptClient(attempts);
    updateSavePreview({ question: currentQuestion, bestAttempt });

    list.innerHTML = sorted
      .map((a, i) => {
        const orderFromOldest = sorted.length - i;
        const time = escapeHtml(
          String(a.createdAt ?? "").slice(0, 16).replace("T", " ")
        );
        const total = totalScoreClient(a.summary);
        const totalLabel =
          total === null ? "未评分" : `${total.toFixed(1)} / 10`;
        const isBest = bestAttempt && a.attemptId === bestAttempt.attemptId;
        const previous = sorted[i + 1];
        const prevTotal = previous ? totalScoreClient(previous.summary) : null;
        const delta =
          total !== null && prevTotal !== null
            ? total - prevTotal
            : null;
        const deltaLabel =
          delta === null
            ? ""
            : delta > 0
            ? `<small class="delta delta-up">↑ ${delta.toFixed(1)}</small>`
            : delta < 0
            ? `<small class="delta delta-down">↓ ${Math.abs(delta).toFixed(1)}</small>`
            : '<small class="delta">持平</small>';
        const summary =
          a.summary?.overallComment ?? (a.status === "scored" ? "已评分" : "未评分");
        const klass = [
          "attempt",
          i === 0 ? "active" : "",
          isBest ? "best" : ""
        ]
          .filter(Boolean)
          .join(" ");
        const bestBadge = isBest
          ? '<span class="best-badge" data-best-attempt>最佳</span>'
          : "";
        return `<article class="${klass}" data-attempt-id="${escapeHtml(a.attemptId)}">
          <span>Attempt ${orderFromOldest} · ${time} · ${totalLabel} ${deltaLabel}</span>
          <p>${escapeHtml(summary)}</p>
          ${bestBadge}
        </article>`;
      })
      .join("");
  } catch (error) {
    console.warn("refreshAttemptHistory failed", error);
  }
}

// --- Step 6 inline helpers: keep the module dependency-free, but mirror
//     src/domain/attemptComparison.js so tests there own the spec.

function totalScoreClient(summary) {
  if (!summary || !summary.scores) return null;
  const keys = [
    "technicalCorrectness",
    "coverageCompleteness",
    "logicalStructure",
    "expressionClarity",
    "interviewPerformance"
  ];
  let sum = 0;
  for (const k of keys) {
    const v = summary.scores[k];
    if (typeof v !== "number" || Number.isNaN(v)) return null;
    sum += v;
  }
  return sum / keys.length;
}

function selectBestAttemptClient(attempts) {
  let best = null;
  let bestTotal = -Infinity;
  for (const a of attempts) {
    const t = totalScoreClient(a.summary);
    if (t === null) continue;
    if (
      t > bestTotal ||
      (t === bestTotal &&
        best !== null &&
        String(a.createdAt ?? "").localeCompare(String(best.createdAt ?? "")) > 0)
    ) {
      best = a;
      bestTotal = t;
    }
  }
  return best;
}

async function setActivePracticeQuestion(questionId) {
  currentQuestionId = questionId;
  if (!questionId) {
    currentQuestion = null;
    return;
  }
  const question = await fetchQuestionById(questionId);
  currentQuestion = question;
  renderPracticeQuestion(question);
  // Default the save-preview category to the question's own category so the
  // user rarely has to change it manually.
  const categorySelect = document.querySelector("[data-save-category]");
  if (categorySelect && question?.category) {
    for (const option of categorySelect.options) {
      if (option.value === question.category) {
        categorySelect.value = question.category;
        break;
      }
    }
  }
  const difficultySelect = document.querySelector("[data-save-difficulty]");
  if (difficultySelect && question?.difficulty) {
    // normalizeDifficulty lives only on the server; for display we map
    // Chinese labels back to en here.
    const zhToEn = { 简单: "easy", 中等: "medium", 困难: "hard" };
    const normalized = zhToEn[question.difficulty] ?? question.difficulty;
    for (const option of difficultySelect.options) {
      if (option.value === normalized) {
        difficultySelect.value = normalized;
        break;
      }
    }
  }
  await refreshAttemptHistory(questionId);
}

const saveAttemptBtn = document.querySelector("[data-save-attempt]");
const attemptStatus = document.querySelector("[data-attempt-status]");

if (saveAttemptBtn) {
  saveAttemptBtn.addEventListener("click", async () => {
    setStatus(attemptStatus, "", null);
    if (!currentQuestionId) {
      setStatus(attemptStatus, "请先从题目库选择一个问题", "error");
      return;
    }
    const input = document.querySelector("[data-answer-input]");
    const answer = input ? input.value : "";
    if (!answer.trim()) {
      setStatus(attemptStatus, "回答不能为空", "error");
      return;
    }
    try {
      const response = await fetch("/api/attempts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionId: currentQuestionId, answer })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setStatus(
          attemptStatus,
          `保存失败: ${body?.error ?? `HTTP ${response.status}`}`,
          "error"
        );
        return;
      }
      lastAttemptId = body?.attemptId ?? null;
      setStatus(attemptStatus, "已保存为第 " + new Date().toLocaleTimeString() + " 的回答", "ok");
      if (input) input.value = "";
      await refreshAttemptHistory(currentQuestionId);
      // Hide any leftover feedback render from a previous attempt — the new
      // attempt has not been scored yet.
      clearFeedbackCard();
    } catch (error) {
      setStatus(attemptStatus, `保存失败: ${error?.message ?? error}`, "error");
    }
  });
}

// ---------------------------------------------------------------------------
// Step 5: scoring-result paste + feedback render
// ---------------------------------------------------------------------------

let lastAttemptId = null;

const scoreForm = document.getElementById("score-input-form");
const scoreStatus = scoreForm
  ? scoreForm.querySelector("[data-score-status]")
  : null;
const toggleScoreBtn = document.querySelector("[data-toggle-score]");
const cancelScoreBtn = document.querySelector("[data-cancel-score]");

function setScoreFormVisible(visible) {
  if (!scoreForm) return;
  scoreForm.hidden = !visible;
  if (!visible) {
    setStatus(scoreStatus, "", null);
  }
}

if (toggleScoreBtn) {
  toggleScoreBtn.addEventListener("click", () => {
    setScoreFormVisible(scoreForm?.hidden !== false);
  });
}
if (cancelScoreBtn) {
  cancelScoreBtn.addEventListener("click", () => setScoreFormVisible(false));
}

function tierFromTotal(total) {
  if (total >= 9) return "优秀";
  if (total >= 8) return "良好";
  if (total >= 6.5) return "中等偏上";
  if (total >= 5) return "勉强及格";
  return "不及格";
}

function clearFeedbackCard() {
  const empty = document.querySelector("[data-feedback-empty]");
  const ok = document.querySelector("[data-feedback-ok]");
  const summary = document.querySelector("[data-feedback-summary]");
  const gapGrid = document.querySelector("[data-gap-grid]");
  const retryBox = document.querySelector("[data-retry-box]");
  if (empty) empty.hidden = false;
  if (ok) ok.hidden = true;
  if (summary) summary.hidden = true;
  if (gapGrid) gapGrid.hidden = true;
  if (retryBox) retryBox.hidden = true;
}

function renderFeedback(scoreRecord) {
  if (!scoreRecord || !scoreRecord.summary) {
    clearFeedbackCard();
    return;
  }
  const empty = document.querySelector("[data-feedback-empty]");
  const ok = document.querySelector("[data-feedback-ok]");
  const summary = document.querySelector("[data-feedback-summary]");
  const gapGrid = document.querySelector("[data-gap-grid]");
  const retryBox = document.querySelector("[data-retry-box]");

  const s = scoreRecord.summary;
  const total = (
    s.scores.technicalCorrectness +
    s.scores.coverageCompleteness +
    s.scores.logicalStructure +
    s.scores.expressionClarity +
    s.scores.interviewPerformance
  ) / 5;

  if (empty) empty.hidden = true;
  if (ok) ok.hidden = false;
  if (summary) summary.hidden = false;
  if (gapGrid) gapGrid.hidden = false;
  if (retryBox) retryBox.hidden = false;

  const big = document.querySelector("[data-big-score]");
  const tier = document.querySelector("[data-big-score-tier]");
  if (big) big.textContent = total.toFixed(1);
  if (tier) tier.textContent = tierFromTotal(total);

  const list = document.querySelector("[data-score-list]");
  if (list) {
    list.innerHTML = `
      <span>技术正确性 <b>${s.scores.technicalCorrectness} / 10</b></span>
      <span>覆盖完整度 <b>${s.scores.coverageCompleteness} / 10</b></span>
      <span>逻辑结构 <b>${s.scores.logicalStructure} / 10</b></span>
      <span>表达清晰度 <b>${s.scores.expressionClarity} / 10</b></span>
      <span>面试表现 <b>${s.scores.interviewPerformance} / 10</b></span>
    `;
  }

  const gapTech = document.querySelector("[data-gap-technical]");
  const gapExpr = document.querySelector("[data-gap-expression]");
  const gapEng = document.querySelector("[data-gap-engineering]");
  const retryEl = document.querySelector("[data-retry-instruction]");
  if (gapTech) gapTech.textContent = s.primaryTechnicalGap ?? "—";
  if (gapExpr) gapExpr.textContent = s.primaryExpressionGap ?? "—";
  if (gapEng) gapEng.textContent = s.engineeringMindsetGap ?? "—";
  if (retryEl) retryEl.textContent = s.retryInstruction ?? "—";
}

if (scoreForm) {
  scoreForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(scoreStatus, "", null);

    if (!lastAttemptId) {
      setStatus(scoreStatus, "请先保存一次回答,然后再粘贴评分", "error");
      return;
    }

    const formData = new FormData(scoreForm);
    const rawResponse = String(formData.get("rawResponse") ?? "");
    if (!rawResponse.trim()) {
      setStatus(scoreStatus, "评分 JSON 不能为空", "error");
      return;
    }

    try {
      const response = await fetch(
        `/api/attempts/${encodeURIComponent(lastAttemptId)}/score`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rawResponse })
        }
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const reason = body?.error ?? `HTTP ${response.status}`;
        const where = body?.path ? ` (${body.path})` : "";
        setStatus(scoreStatus, `评分失败: ${reason}${where}`, "error");
        return;
      }
      setStatus(scoreStatus, "评分通过校验", "ok");
      renderFeedback(body);
      // Refresh attempt list so the latest summary surfaces in history too.
      if (currentQuestionId) await refreshAttemptHistory(currentQuestionId);
      setTimeout(() => setScoreFormVisible(false), 200);
    } catch (error) {
      setStatus(scoreStatus, `评分失败: ${error?.message ?? error}`, "error");
    }
  });
}

// ---------------------------------------------------------------------------
// Step 7: save a scored attempt as a curated CardRecord
// ---------------------------------------------------------------------------

const saveCardForm = document.querySelector("[data-save-card-form]");
const saveCardBtn = saveCardForm?.querySelector("[data-save-card-btn]");
const saveStatus = document.querySelector("[data-save-status]");
const saveHint = document.querySelector("[data-save-preview-hint]");
const saveCheckScore = document.querySelector("[data-save-check-score]");
const saveChecklist = document.querySelector("[data-save-checklist]");

function updateSavePreview({ question, bestAttempt }) {
  bestAttemptForSave = bestAttempt ?? null;

  if (!question) {
    if (saveHint) saveHint.textContent = "请先从题目库选择一个问题。";
    if (saveCardBtn) saveCardBtn.disabled = true;
    if (saveCheckScore) {
      saveCheckScore.textContent = "未选择问题";
      saveCheckScore.className = "warn";
    }
    return;
  }

  if (!bestAttempt || !bestAttempt.summary) {
    if (saveHint) {
      saveHint.textContent =
        "保存前需要至少一次完整评分。粘贴 LLM 评分 JSON 通过校验后,这里会解锁。";
    }
    if (saveCardBtn) saveCardBtn.disabled = true;
    if (saveCheckScore) {
      saveCheckScore.textContent = "还没有通过校验的评分";
      saveCheckScore.className = "warn";
    }
    return;
  }

  // Scored + ready — unlock the save button. Show which attempt will be
  // promoted so the user is not surprised.
  const total = totalScoreClient(bestAttempt.summary);
  const totalLabel = total === null ? "—" : total.toFixed(1);
  if (saveHint) {
    saveHint.textContent = `将保存最佳回答 (${totalLabel} / 10),分类和难度可在下面调整。`;
  }
  if (saveCardBtn) saveCardBtn.disabled = false;
  if (saveCheckScore) {
    saveCheckScore.textContent = `最佳评分 ${totalLabel}`;
    saveCheckScore.className = "ok";
  }
}

if (saveCardForm) {
  saveCardForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(saveStatus, "", null);

    if (!bestAttemptForSave) {
      setStatus(saveStatus, "还没有可保存的评分 attempt", "error");
      return;
    }
    const data = new FormData(saveCardForm);
    const payload = {
      attemptId: bestAttemptForSave.attemptId,
      category: String(data.get("category") ?? ""),
      difficulty: String(data.get("difficulty") ?? ""),
      overwrite: false
    };

    try {
      const response = await fetch("/api/cards/from-attempt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = await response.json().catch(() => null);
      if (response.status === 400 && body?.code === "CARD_DUPLICATE_ID") {
        // Confirm once before overwriting.
        const ok = window.confirm
          ? window.confirm("同名卡片已存在,是否覆盖?")
          : true;
        if (!ok) {
          setStatus(saveStatus, "已取消保存", "error");
          return;
        }
        const retry = await fetch("/api/cards/from-attempt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, overwrite: true })
        });
        const retryBody = await retry.json().catch(() => null);
        if (!retry.ok) {
          setStatus(
            saveStatus,
            `保存失败: ${retryBody?.error ?? `HTTP ${retry.status}`}`,
            "error"
          );
          return;
        }
        setStatus(saveStatus, `已覆盖保存: ${retryBody.id}`, "ok");
        return;
      }
      if (!response.ok) {
        setStatus(
          saveStatus,
          `保存失败: ${body?.error ?? `HTTP ${response.status}`}`,
          "error"
        );
        return;
      }
      setStatus(saveStatus, `已保存卡片: ${body.id}`, "ok");
    } catch (error) {
      setStatus(saveStatus, `保存失败: ${error?.message ?? error}`, "error");
    }
  });
}
