// Interview Training Workbench — frontend bootstrap.
//
// One file by design (no bundler). Sections below mirror the Phase A steps
// they implement, so each block can be read independently. State lives in
// module-level variables; the server is the source of truth — every action
// re-reads from /api/* rather than mutating local copies.

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let currentQuestionId = null;
let currentQuestion = null;
let lastAttemptId = null;
let bestAttemptForSave = null;

// User can filter the question grid by sidebar category and a search keyword.
// "" means "all categories"; the search box matches question text + tags + source.
let activeCategory = "";
let activeSearch = "";
let lastKnownQuery = "__feed__";
// Cache the last list response so sidebar counts and the toolbar summary can
// update without a second round-trip.
let lastQuestionsResponse = { questions: [], meta: null };
let lastAttemptsByQuestion = new Map(); // questionId -> attempts[]

// ---------------------------------------------------------------------------
// Frontend persistence (localStorage)
// ---------------------------------------------------------------------------
//
// The backend remains the source of truth — these keys only persist
// navigation state so the user does not lose their place on refresh.

const STORAGE_KEYS = Object.freeze({
  lastKnownQuery: "itw.lastKnownQuery",
  currentQuestionId: "itw.currentQuestionId"
});
const VALID_VIEWS = new Set(["home", "practice", "cards"]);

function safeStorageGet(key) {
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    if (value === null || value === undefined || value === "") {
      window.localStorage?.removeItem(key);
    } else {
      window.localStorage?.setItem(key, String(value));
    }
  } catch {
    /* localStorage may be disabled (private mode); we degrade silently. */
  }
}

function setLastKnownQuery(partition) {
  if (typeof partition !== "string" || partition.length === 0) return;
  lastKnownQuery = partition;
  safeStorageSet(STORAGE_KEYS.lastKnownQuery, partition);
}

function setCurrentQuestionIdState(id) {
  currentQuestionId = id ?? null;
  safeStorageSet(STORAGE_KEYS.currentQuestionId, currentQuestionId);
}

// ---------------------------------------------------------------------------
// Generic helpers
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

function statusLabelZh(s) {
  return (
    {
      candidate: "候选",
      accepted: "已练",
      ignored: "已忽略",
      duplicate: "重复",
      mastered: "已掌握",
      answered: "已作答",
      scored: "已评分"
    }[s] ?? s
  );
}

// ---------------------------------------------------------------------------
// View switching (home / practice / cards)
// ---------------------------------------------------------------------------

const views = document.querySelectorAll("[data-view]");
const navLinks = document.querySelectorAll("[data-view-link]");

function showView(name, options = {}) {
  if (!VALID_VIEWS.has(name)) name = "home";
  views.forEach((view) => {
    const active = view.dataset.view === name;
    view.hidden = !active;
    view.classList.toggle("active-view", active);
  });
  navLinks.forEach((link) => {
    link.classList.toggle("active", link.dataset.viewLink === name);
  });

  // Persist current view in the URL so a refresh restores the same screen.
  // We deliberately only manage the hash; the rest of the URL is untouched.
  if (typeof window !== "undefined" && window.location) {
    const desired = `#${name}`;
    if (window.location.hash !== desired) {
      try {
        window.location.hash = name;
      } catch {
        /* some embedded environments forbid hash writes */
      }
    }
  }

  if (typeof window.scrollTo === "function") {
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      /* jsdom or embedded environments may throw */
    }
  }

  if (name === "practice" && options.questionId) {
    setActivePracticeQuestion(options.questionId);
  }
  if (name === "home") {
    // Leaving practice clears the persisted question pointer so a later
    // refresh on the home view does not bounce the user back.
    setCurrentQuestionIdState(null);
    refreshQuestionPool(lastKnownQuery).catch(() => {});
  }
  if (name === "cards") {
    refreshCardsView().catch(() => {});
  }
}

document.querySelectorAll("[data-back-home]").forEach((btn) => {
  btn.addEventListener("click", () => showView("home"));
});

navLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showView(link.dataset.viewLink);
  });
});

// Card "开始练习" buttons are dynamically rendered, so we delegate.
document.addEventListener("click", (event) => {
  const trigger = event.target.closest?.("[data-open-practice]");
  if (!trigger) return;
  const card = trigger.closest("[data-question-id]");
  const id = card?.dataset.questionId ?? null;
  showView("practice", { questionId: id });
});

// ---------------------------------------------------------------------------
// Header buttons (导入文章 / + 新建训练卡片)
// ---------------------------------------------------------------------------

document.querySelector("[data-header-import]")?.addEventListener("click", () => {
  showView("home");
  showSourcePanel("manual");
  document.querySelector("[data-source-tab='manual']")?.classList.add("active");
  document.getElementById("manual-import-form")?.querySelector("[name=title]")?.focus();
});

document.querySelector("[data-header-new-card]")?.addEventListener("click", () => {
  // "新建训练卡片" in the header == 同 toolbar 的 + 新建,跳到手动录题面板
  // 因为 Phase A 不允许凭空写卡片,必须先有问题 + attempt + 评分。
  showView("home");
  showSourcePanel("extract");
  document.getElementById("extract-import-form")
    ?.querySelector("[name=question]")
    ?.focus();
});

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
// Step 2: manual article import (recent-imports list removed in feed refactor)
// ---------------------------------------------------------------------------

const importForm = document.getElementById("manual-import-form");
const importStatus = importForm?.querySelector("[data-source-status]");

if (importForm) {
  importForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(importStatus, "", null);
    const data = new FormData(importForm);
    const payload = {
      query: String(data.get("query") ?? "").trim() || "面经",
      title: String(data.get("title") ?? "").trim(),
      text: String(data.get("text") ?? "")
    };
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
        setStatus(importStatus, `保存失败: ${body?.error ?? `HTTP ${response.status}`}`, "error");
        return;
      }
      setStatus(importStatus, `已保存: ${body?.title ?? payload.title}`, "ok");
      importForm.querySelector("[name=title]").value = "";
      importForm.querySelector("[name=text]").value = "";
      setLastKnownQuery(payload.query);
      await refreshQuestionPool(lastKnownQuery);
    } catch (error) {
      setStatus(importStatus, `保存失败: ${error?.message ?? error}`, "error");
    }
  });
}

// ---------------------------------------------------------------------------
// Step 3: question pool (manual question entry + render + ignore action)
// ---------------------------------------------------------------------------

const extractForm = document.getElementById("extract-import-form");
const extractStatus = extractForm?.querySelector("[data-source-status]");

function applyFilters(questions) {
  return questions.filter((q) => {
    if (activeCategory && q.category !== activeCategory) return false;
    if (activeSearch) {
      const haystack =
        `${q.question ?? ""} ${(q.tags ?? []).join(" ")} ${q.source ?? ""} ${q.evidence ?? ""}`.toLowerCase();
      if (!haystack.includes(activeSearch.toLowerCase())) return false;
    }
    return true;
  });
}

function sortQuestionsForGrid(questions) {
  return [...questions].sort((a, b) => {
    const aManual = a?.source === "manual" ? 1 : 0;
    const bManual = b?.source === "manual" ? 1 : 0;
    if (aManual !== bManual) return bManual - aManual;

    const aTime = Date.parse(a?.updatedAt ?? a?.createdAt ?? "") || 0;
    const bTime = Date.parse(b?.updatedAt ?? b?.createdAt ?? "") || 0;
    if (aTime !== bTime) return bTime - aTime;

    return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
  });
}

function renderQuestionGrid(questions) {
  const grid = document.querySelector("[data-question-grid]");
  if (!grid) return;
  const filtered = sortQuestionsForGrid(applyFilters(questions));

  if (filtered.length === 0) {
    grid.innerHTML = `
      <article class="training-card add-card" data-add-card>
        <strong>+</strong>
        <h4>${activeCategory || activeSearch ? "当前筛选下没有问题" : "手动录题以填充问题池"}</h4>
        <p>${
          activeCategory || activeSearch
            ? '试试切换"全部"分类或清空搜索框。'
            : '侧栏“手动录题”里直接选择方向并输入问题即可。'
        }</p>
      </article>`;
    return;
  }

  const cards = filtered.map((q) => {
    const muted = q.status === "ignored" || q.status === "duplicate";
    const klass = muted
      ? "training-card muted"
      : q.status === "mastered"
      ? "training-card mastered"
      : "training-card";
    const evidence = q.evidence
      ? escapeHtml(String(q.evidence).slice(0, 90))
      : "暂无来源片段";
    const confidencePct = Math.round((q.confidence ?? 0) * 100);
    return `<article class="${klass}" data-question-id="${escapeHtml(q.id)}">
      <div class="card-topline">
        <span>${escapeHtml(q.category)}</span>
        <em>${escapeHtml(statusLabelZh(q.status))}</em>
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

  cards.push(`
    <article class="training-card add-card" data-add-card>
      <strong>+</strong>
      <h4>继续手动录题</h4>
      <p>继续补充你想练的问题。</p>
    </article>`);

  grid.innerHTML = cards.join("");
}

function renderCategoryCounts(questions) {
  const counts = new Map();
  for (const q of questions) {
    counts.set(q.category, (counts.get(q.category) ?? 0) + 1);
  }
  document.querySelectorAll("[data-category-count]").forEach((node) => {
    const cat = node.dataset.categoryCount;
    node.textContent = cat === "" ? String(questions.length) : String(counts.get(cat) ?? 0);
  });
  document.querySelectorAll("[data-category]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.category === activeCategory);
  });
}

function renderToolbarSummary(questions) {
  const summary = document.querySelector("[data-toolbar-summary]");
  if (!summary) return;
  const total = questions.length;
  const candidate = questions.filter((q) => q.status === "candidate").length;
  const mastered = questions.filter((q) => q.status === "mastered").length;
  const filtered = applyFilters(questions).length;
  if (total === 0) {
    summary.textContent = "暂无问题";
    return;
  }
  // ignored is filtered out by the API by default — no longer shown in
  // the summary. The toolbar button "清空已忽略" handles bulk cleanup.
  let text = `共 ${total} 个问题 · ${candidate} 候选 · ${mastered} 已掌握`;
  if (filtered !== total) {
    text += ` · 当前筛选 ${filtered}`;
  }
  summary.textContent = text;
}

async function refreshQuestionPool(query) {
  try {
    const response = await fetch("/api/questions");
    if (!response.ok) {
      lastQuestionsResponse = { questions: [], meta: null };
      renderQuestionGrid([]);
      renderCategoryCounts([]);
      renderToolbarSummary([]);
      await refreshMetricStrip([]);
      return;
    }
    const body = await response.json();
    const questions = Array.isArray(body.questions) ? body.questions : [];
    lastQuestionsResponse = { questions, meta: body.meta ?? null };
    renderQuestionGrid(questions);
    renderCategoryCounts(questions);
    renderToolbarSummary(questions);
    await refreshMetricStrip(questions);
  } catch (error) {
    console.warn("refreshQuestionPool failed", error);
  }
}

if (extractForm) {
  extractForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(extractStatus, "", null);
    const data = new FormData(extractForm);
    const queryPartition =
      typeof lastKnownQuery === "string" && lastKnownQuery.trim().length > 0
        ? lastKnownQuery.trim()
        : "__feed__";
    const category = String(data.get("category") ?? "").trim();
    const question = String(data.get("question") ?? "").trim();
    const evidence = String(data.get("evidence") ?? "").trim();
    if (!category) return setStatus(extractStatus, "方向不能为空", "error");
    if (!question) return setStatus(extractStatus, "问题不能为空", "error");

    try {
      const response = await fetch("/api/questions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: queryPartition,
          source: "manual",
          extraction: {
            questions: [
              {
                question,
                category,
                difficulty: "medium",
                evidence: evidence || undefined,
                confidence: 1
              }
            ]
          }
        })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setStatus(extractStatus, `录入失败: ${body?.error ?? `HTTP ${response.status}`}`, "error");
        return;
      }
      const purgedNote =
        Number.isInteger(body?.purgedIgnored) && body.purgedIgnored > 0
          ? ` · 已清理 ${body.purgedIgnored} 条忽略`
          : "";
      setStatus(
        extractStatus,
        `已加入 ${body.added.length} 条 · 重复 ${body.duplicates.length} · 错误 ${body.errors.length}${purgedNote}`,
        body.added.length > 0 ? "ok" : "error"
      );
      extractForm.querySelector("[name=question]").value = "";
      extractForm.querySelector("[name=evidence]").value = "";
      await refreshQuestionPool(lastKnownQuery);
    } catch (error) {
      setStatus(extractStatus, `录入失败: ${error?.message ?? error}`, "error");
    }
  });
}

// Automatic extraction now happens inside /api/sources/nowcoder/fetch.
// The sidebar extract panel is repurposed as direct manual question entry.

// Delegated PATCH handler for question triage actions.
document.addEventListener("click", async (event) => {
  const target = event.target.closest?.("[data-question-action]");
  if (!target) return;
  const action = target.dataset.questionAction;
  const card = target.closest("[data-question-id]");
  const id = card?.dataset.questionId;
  if (!id) return;
  if (action !== "ignore") return;

  if (card) card.classList.add("muted");
  try {
    const response = await fetch(`/api/questions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ignored" })
    });
    if (!response.ok) console.warn("question patch failed", response.status);
  } catch (error) {
    console.warn("question patch failed", error);
  }
  await refreshQuestionPool(lastKnownQuery);
});

// ---------------------------------------------------------------------------
// Toolbar wiring (search + clear filter + 新建)
// ---------------------------------------------------------------------------

const searchInput = document.querySelector("[data-search-input]");
const clearFilterBtn = document.querySelector("[data-clear-filter]");
const purgeIgnoredBtn = document.querySelector("[data-purge-ignored]");
const newQuestionBtn = document.querySelector("[data-new-question]");

if (searchInput) {
  let debounceHandle;
  searchInput.addEventListener("input", () => {
    if (debounceHandle) clearTimeout(debounceHandle);
    debounceHandle = setTimeout(() => {
      activeSearch = searchInput.value.trim();
      renderQuestionGrid(lastQuestionsResponse.questions);
      renderToolbarSummary(lastQuestionsResponse.questions);
    }, 120);
  });
}

if (clearFilterBtn) {
  clearFilterBtn.addEventListener("click", () => {
    activeSearch = "";
    activeCategory = "";
    if (searchInput) searchInput.value = "";
    renderQuestionGrid(lastQuestionsResponse.questions);
    renderCategoryCounts(lastQuestionsResponse.questions);
    renderToolbarSummary(lastQuestionsResponse.questions);
  });
}

if (purgeIgnoredBtn) {
  purgeIgnoredBtn.addEventListener("click", async () => {
    const ok = window.confirm(
      "确认物理删除所有已忽略的题?该操作不可撤销,但 attempts/scores 历史保留。"
    );
    if (!ok) return;
    purgeIgnoredBtn.disabled = true;
    try {
      const response = await fetch("/api/questions/purge-ignored", {
        method: "POST",
        headers: { "content-type": "application/json" }
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        window.alert(`清空失败: ${body?.error ?? `HTTP ${response.status}`}`);
        return;
      }
      const count = Number.isInteger(body?.removedCount) ? body.removedCount : 0;
      const summary = document.querySelector("[data-toolbar-summary]");
      if (summary) {
        summary.textContent =
          count === 0
            ? "当前已忽略池为空"
            : `已物理删除 ${count} 条已忽略`;
      }
      await refreshQuestionPool(lastKnownQuery);
    } catch (error) {
      window.alert(`清空失败: ${error?.message ?? error}`);
    } finally {
      purgeIgnoredBtn.disabled = false;
    }
  });
}

if (newQuestionBtn) {
  newQuestionBtn.addEventListener("click", () => {
    showSourcePanel("extract");
    document.getElementById("extract-import-form")
      ?.querySelector("[name=question]")
      ?.focus();
  });
}

// Sidebar category buttons
document.querySelectorAll("[data-category]").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeCategory = btn.dataset.category;
    renderQuestionGrid(lastQuestionsResponse.questions);
    renderCategoryCounts(lastQuestionsResponse.questions);
    renderToolbarSummary(lastQuestionsResponse.questions);
  });
});

// ---------------------------------------------------------------------------
// Metric strip (总问题 / 已作答 / 平均分 / 待重答)
// ---------------------------------------------------------------------------

async function refreshMetricStrip(questions) {
  const total = questions.length;
  const node = (key) => document.querySelector(`[data-metric="${key}"]`);
  if (node("total")) node("total").textContent = String(total);

  // Tally answered/scored attempts across every visible question. We do a
  // small N+1 (one /api/attempts call per question) — fine for Phase A
  // scale (a few dozen questions).
  let answered = 0;
  let scored = 0;
  let totalScoreSum = 0;
  let totalScoreCount = 0;
  let needsRetry = 0;

  await Promise.all(
    questions.map(async (q) => {
      try {
        const r = await fetch(`/api/attempts?questionId=${encodeURIComponent(q.id)}`);
        if (!r.ok) return;
        const body = await r.json();
        const list = body.attempts ?? [];
        lastAttemptsByQuestion.set(q.id, list);
        if (list.length > 0) answered += 1;
        const scoredOnes = list.filter((a) => a.summary);
        if (scoredOnes.length > 0) {
          scored += 1;
          // Use the latest scored attempt for the running average.
          const latest = scoredOnes[scoredOnes.length - 1];
          const t = totalScoreClient(latest.summary);
          if (t !== null) {
            totalScoreSum += t;
            totalScoreCount += 1;
            if (t < 7) needsRetry += 1;
          }
        }
      } catch {
        /* per-question failure shouldn't break the whole strip */
      }
    })
  );

  if (node("answered")) node("answered").textContent = String(answered);
  if (node("avgScore")) {
    node("avgScore").textContent =
      totalScoreCount > 0 ? (totalScoreSum / totalScoreCount).toFixed(1) : "—";
  }
  if (node("needsRetry")) node("needsRetry").textContent = String(needsRetry);
}

// ---------------------------------------------------------------------------
// Step 4: practice-view question hydration + answer attempts
// ---------------------------------------------------------------------------

async function fetchQuestionById(id) {
  try {
    const response = await fetch("/api/questions");
    if (!response.ok) return null;
    const body = await response.json();
    const found = (body.questions ?? []).find((row) => row.id === id);
    if (found) return found;
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
  if (meta)
    meta.textContent = `${q.category} · ${statusLabelZh(q.status)} · Practice Mode`;
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
    const response = await fetch(`/api/attempts?questionId=${encodeURIComponent(questionId)}`);
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
    const sorted = attempts.slice().reverse();
    lastAttemptId = sorted[0]?.attemptId ?? null;
    if (sorted[0]?.summary) {
      renderFeedback({ summary: sorted[0].summary });
    } else {
      clearFeedbackCard();
    }

    const bestAttempt = selectBestAttemptClient(attempts);
    updateSavePreview({ question: currentQuestion, bestAttempt });

    list.innerHTML = sorted
      .map((a, i) => {
        const orderFromOldest = sorted.length - i;
        const time = escapeHtml(
          String(a.createdAt ?? "").slice(0, 16).replace("T", " ")
        );
        const total = totalScoreClient(a.summary);
        const totalLabel = total === null ? "未评分" : `${total.toFixed(1)} / 10`;
        const isBest = bestAttempt && a.attemptId === bestAttempt.attemptId;
        const previous = sorted[i + 1];
        const prevTotal = previous ? totalScoreClient(previous.summary) : null;
        const delta =
          total !== null && prevTotal !== null ? total - prevTotal : null;
        const deltaLabel =
          delta === null
            ? ""
            : delta > 0
            ? `<small class="delta delta-up">↑ ${delta.toFixed(1)}</small>`
            : delta < 0
            ? `<small class="delta delta-down">↓ ${Math.abs(delta).toFixed(1)}</small>`
            : '<small class="delta">持平</small>';
        const summary =
          a.summary?.overallComment ??
          (a.status === "scored" ? "已评分" : "未评分");
        const klass = ["attempt", i === 0 ? "active" : "", isBest ? "best" : ""]
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
  setCurrentQuestionIdState(questionId);
  if (!questionId) {
    currentQuestion = null;
    return;
  }
  let question;
  try {
    question = await fetchQuestionById(questionId);
  } catch (err) {
    // Stale id (purged / promoted to a card / never existed). Roll back to
    // home so the user is not stuck on an empty practice page.
    console.warn("setActivePracticeQuestion: question lookup failed", err);
    currentQuestion = null;
    setCurrentQuestionIdState(null);
    showView("home");
    return;
  }
  if (!question) {
    currentQuestion = null;
    setCurrentQuestionIdState(null);
    showView("home");
    return;
  }
  currentQuestion = question;
  renderPracticeQuestion(question);

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
      setStatus(
        attemptStatus,
        "已保存为第 " + new Date().toLocaleTimeString() + " 的回答",
        "ok"
      );
      if (input) input.value = "";
      await refreshAttemptHistory(currentQuestionId);
      clearFeedbackCard();
    } catch (error) {
      setStatus(attemptStatus, `保存失败: ${error?.message ?? error}`, "error");
    }
  });
}

document.querySelector("[data-new-attempt]")?.addEventListener("click", () => {
  const input = document.querySelector("[data-answer-input]");
  if (input) {
    input.value = "";
    try {
      input.focus();
    } catch {
      /* jsdom focus may throw */
    }
  }
  setStatus(attemptStatus, "", null);
});

// ---------------------------------------------------------------------------
// Step 5: scoring (paste JSON + LLM auto-score) + feedback render
// ---------------------------------------------------------------------------

const scoreForm = document.getElementById("score-input-form");
const scoreStatus = scoreForm?.querySelector("[data-score-status]");
const toggleScoreBtn = document.querySelector("[data-toggle-score]");
const cancelScoreBtn = document.querySelector("[data-cancel-score]");

function setScoreFormVisible(visible) {
  if (!scoreForm) return;
  scoreForm.hidden = !visible;
  if (!visible) setStatus(scoreStatus, "", null);
}

toggleScoreBtn?.addEventListener("click", () => {
  setScoreFormVisible(scoreForm?.hidden !== false);
});
cancelScoreBtn?.addEventListener("click", () => setScoreFormVisible(false));

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
  document
    .querySelectorAll("[data-feedback-section]")
    .forEach((node) => (node.hidden = true));
  if (empty) empty.hidden = false;
  if (ok) ok.hidden = true;
  // Reset feedback tabs to summary.
  document.querySelectorAll("[data-feedback-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.feedbackTab === "summary");
  });
  const overall = document.querySelector("[data-overall-comment]");
  if (overall) overall.textContent = "—";
}

let activeFeedbackTab = "summary";

function showFeedbackSections() {
  const empty = document.querySelector("[data-feedback-empty]");
  const ok = document.querySelector("[data-feedback-ok]");
  if (empty) empty.hidden = true;
  if (ok) ok.hidden = false;
  document.querySelectorAll("[data-feedback-section]").forEach((node) => {
    node.hidden = node.dataset.feedbackSection !== activeFeedbackTab;
  });
}

document.querySelectorAll("[data-feedback-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeFeedbackTab = btn.dataset.feedbackTab;
    document
      .querySelectorAll("[data-feedback-tab]")
      .forEach((b) => b.classList.toggle("active", b === btn));
    // Only switch sections if a summary is present (not in empty state).
    const empty = document.querySelector("[data-feedback-empty]");
    if (empty && empty.hidden) showFeedbackSections();
  });
});

function renderFeedback(scoreRecord) {
  if (!scoreRecord || !scoreRecord.summary) {
    clearFeedbackCard();
    return;
  }
  const s = scoreRecord.summary;
  const total =
    (s.scores.technicalCorrectness +
      s.scores.coverageCompleteness +
      s.scores.logicalStructure +
      s.scores.expressionClarity +
      s.scores.interviewPerformance) /
    5;

  const big = document.querySelector("[data-big-score]");
  const tier = document.querySelector("[data-big-score-tier]");
  const totalBar = document.querySelector("[data-total-score-bar]");
  if (big) big.textContent = total.toFixed(1);
  if (tier) tier.textContent = tierFromTotal(total);
  if (totalBar) totalBar.style.width = `${Math.max(0, Math.min(100, total * 10))}%`;
  const overall = document.querySelector("[data-overall-comment]");
  if (overall) overall.textContent = s.overallComment ?? "—";

  const list = document.querySelector("[data-score-list]");
  if (list) {
    list.innerHTML = renderScoreRows([
      ["技术正确性", s.scores.technicalCorrectness],
      ["覆盖完整度", s.scores.coverageCompleteness],
      ["逻辑结构", s.scores.logicalStructure],
      ["表达清晰度", s.scores.expressionClarity],
      ["面试表现", s.scores.interviewPerformance]
    ]);
  }

  const expressionNotes = [
    s.primaryExpressionGap,
  ].filter(Boolean);
  const engineeringNotes = [
    s.engineeringMindsetGap,
    s.interviewerReview?.firstImpression,
    s.interviewerReview?.followUpReason
  ].filter(Boolean);

  document.querySelector("[data-gap-technical-detail]").textContent = s.primaryTechnicalGap ?? "—";
  document.querySelector("[data-gap-expression-detail]").textContent =
    expressionNotes.join("\n\n") || "—";
  document.querySelector("[data-gap-engineering-detail]").textContent =
    engineeringNotes.join("\n\n") || "—";
  document.querySelector("[data-retry-detail]").textContent = s.retryInstruction ?? "—";

  renderInterviewerReview(s.interviewerReview);
  renderExpressionAnalysis(s.expressionAnalysis);
  renderTechnicalAnalysis(s.technicalAnalysis);
  renderHighScoreAnswer(s.highScoreAnswer);
  renderEssence(s.essence);
  renderLongTermAdvice(s.longTermAdvice);
  renderExpressionComparison(s.expressionComparison);
  renderFollowUpQuestions(s.followUpQuestions);

  showFeedbackSections();
}

function renderScoreRows(entries) {
  return entries
    .map(([label, value]) => {
      const score = Number(value) || 0;
      const width = Math.max(0, Math.min(100, score * 10));
      return `<article class="score-row-card">
        <div><span>${escapeHtml(label)}</span><b>${escapeHtml(String(score.toFixed(1).replace(/\.0$/, "")))} / 10</b></div>
        <div class="score-track"><i style="width:${width}%"></i></div>
      </article>`;
    })
    .join("");
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function renderNamedList(title, items, className = "") {
  const clean = normalizeList(items);
  if (clean.length === 0) return "";
  const klass = className ? ` class="${escapeHtml(className)}"` : "";
  return `<section${klass}><strong>${escapeHtml(title)}</strong><ul>${clean
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("")}</ul></section>`;
}

function renderFieldBlock(title, value, className = "") {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const klass = className ? ` class="${escapeHtml(className)}"` : "";
  return `<section${klass}><strong>${escapeHtml(title)}</strong><p>${escapeHtml(text)}</p></section>`;
}

function renderInterviewerReview(review) {
  const node = document.querySelector("[data-interviewer-review]");
  if (!node) return;
  if (!review || typeof review !== "object") {
    node.innerHTML = "";
    return;
  }
  node.innerHTML = [
    renderFieldBlock("第一印象", review.firstImpression, "review-block lead"),
    renderFieldBlock("回答类型", review.answerType, "review-block compact"),
    renderFieldBlock("是否会追问", review.willFollowUp === true ? "会" : review.willFollowUp === false ? "不会" : "", "review-block compact"),
    renderFieldBlock("追问原因", review.followUpReason, "review-block"),
    renderNamedList("不专业信号", review.unprofessionalSignals, "review-signals")
  ].join("");
}

function renderExpressionAnalysis(analysis) {
  const node = document.querySelector("[data-expression-analysis]");
  if (!node) return;
  if (!analysis || typeof analysis !== "object") {
    node.innerHTML = "";
    return;
  }
  const sentenceIssues = Array.isArray(analysis.sentenceIssues)
    ? analysis.sentenceIssues.filter((item) => item && typeof item === "object")
    : [];
  node.innerHTML = [
    renderAnalysisGroup("MECE", [
      renderFieldBlock("判断", analysis.mece?.conclusion, "analysis-note"),
      renderFieldBlock("结构完整性", analysis.mece?.structureCompleteness, "analysis-note"),
      renderNamedList("重复表达", analysis.mece?.duplicateExpressions, "analysis-list"),
      renderNamedList("缺失关键点", analysis.mece?.missingKeyPoints, "analysis-list")
    ]),
    renderAnalysisGroup("结构", [
      renderFieldBlock("整体判断", analysis.structure?.conclusion, "analysis-note"),
      renderFieldBlock("先总后分", analysis.structure?.topDown, "analysis-note"),
      renderFieldBlock("分点清晰度", analysis.structure?.clearPoints, "analysis-note"),
      renderFieldBlock("主线问题", analysis.structure?.wanderingProblem, "analysis-note")
    ]),
    renderAnalysisGroup("SCQA", [
      renderFieldBlock("背景", analysis.scqa?.situation, "scqa-step"),
      renderFieldBlock("复杂点", analysis.scqa?.complication, "scqa-step"),
      renderFieldBlock("面试官真正想问", analysis.scqa?.question, "scqa-step"),
      renderFieldBlock("理想回答主线", analysis.scqa?.answer, "scqa-step answer"),
      renderNamedList("当前问题", analysis.scqa?.problems, "analysis-list")
    ]),
    sentenceIssues.length
      ? `<section class="sentence-review"><strong>逐句问题</strong>${sentenceIssues
          .map(
            (item) => `<article class="follow-up">
              <b>${escapeHtml(item.quote || "—")}</b>
              <p>${escapeHtml(item.issue || "")}</p>
              <p>${escapeHtml(item.suggestion || "")}</p>
            </article>`
          )
          .join("")}</section>`
      : ""
  ].join("");
}

function renderAnalysisGroup(title, parts) {
  const body = parts.filter(Boolean).join("");
  if (!body) return "";
  return `<section class="analysis-group"><strong>${escapeHtml(title)}</strong>${body}</section>`;
}

function renderTechnicalAnalysis(analysis) {
  const node = document.querySelector("[data-technical-analysis]");
  if (!node) return;
  if (!analysis || typeof analysis !== "object") {
    node.innerHTML = "";
    return;
  }
  node.innerHTML = [
    renderNamedList("错误 / 混淆", analysis.errors, "tech-list errors"),
    renderNamedList("误解", analysis.misunderstandings, "tech-list warnings"),
    renderNamedList("浅层回答", analysis.shallowParts, "tech-list shallow"),
    renderNamedList("缺失知识", analysis.missingKnowledge, "tech-list missing"),
    renderNamedList("应展开", analysis.shouldExpand, "tech-list expand")
  ].join("");
}

function renderHighScoreAnswer(highScoreAnswer) {
  const node = document.querySelector("[data-high-score-answer]");
  if (!node) return;
  const basic = String(highScoreAnswer?.basic ?? "").trim();
  const advanced = String(highScoreAnswer?.advanced ?? "").trim();
  node.innerHTML = `
    <article class="answer-card basic">
      <strong>基础版</strong>
      <p>${escapeHtml(basic || "—")}</p>
    </article>
    <article class="answer-card advanced">
      <strong>进阶版</strong>
      <p>${escapeHtml(advanced || "—")}</p>
    </article>
  `;
}

function renderExpressionComparison(comparison) {
  const node = document.querySelector("[data-expression-comparison]");
  if (!node) return;
  if (!comparison || typeof comparison !== "object") {
    node.innerHTML = "";
    return;
  }
  const changes = renderNamedList("关键变化", comparison.keyChanges);
  node.innerHTML = `
    <section class="comparison-before">
      <strong>原回答</strong>
      <p>${escapeHtml(comparison.original || "—")}</p>
    </section>
    <section class="comparison-after">
      <strong>优化表达</strong>
      <p>${escapeHtml(comparison.optimized || "—")}</p>
    </section>
    ${changes}
  `;
}

function renderEssence(essence) {
  const node = document.querySelector("[data-essence]");
  if (!node) return;
  if (!essence || typeof essence !== "object") {
    node.innerHTML = "";
    return;
  }
  node.innerHTML = [
    renderFieldBlock("考察意图", essence.examIntent, "essence-block intent"),
    renderFieldBlock("题型", essence.questionType, "essence-block type"),
    renderFieldBlock("重要性", essence.importance, "essence-block importance")
  ].join("");
}

function renderLongTermAdvice(advice) {
  const node = document.querySelector("[data-long-term-advice]");
  if (!node) return;
  if (!advice || typeof advice !== "object") {
    node.innerHTML = "";
    return;
  }
  node.innerHTML = [
    renderNamedList("常见问题", advice.commonProblems, "advice-list common"),
    renderNamedList("表达习惯", advice.expressionHabits, "advice-list habits"),
    renderNamedList("资深建议", advice.experiencedEngineerTips, "advice-list senior"),
    renderFieldBlock("核心目标", advice.finalCoreGoal, "advice-goal")
  ].join("");
}

function renderFollowUpQuestions(questions) {
  const node = document.querySelector("[data-follow-up-questions]");
  if (!node) return;
  const clean = Array.isArray(questions)
    ? questions.filter((item) => item && typeof item === "object")
    : [];
  if (clean.length === 0) {
    node.innerHTML = "";
    return;
  }
  node.innerHTML = `<section><strong>可能追问</strong>${clean
    .map(
      (item) => `<article class="follow-up">
        <b>${escapeHtml(item.question || "—")}</b>
        <p>${escapeHtml(item.whyAsk || "")}</p>
        <p>${escapeHtml(item.answerHint || "")}</p>
      </article>`
    )
    .join("")}</section>`;
}

if (scoreForm) {
  scoreForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(scoreStatus, "", null);
    if (!lastAttemptId) {
      setStatus(scoreStatus, "请先保存一次回答,然后再粘贴评分", "error");
      return;
    }
    const data = new FormData(scoreForm);
    const rawResponse = String(data.get("rawResponse") ?? "");
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
        const where = body?.path ? ` (${body.path})` : "";
        setStatus(
          scoreStatus,
          `评分失败: ${body?.error ?? `HTTP ${response.status}`}${where}`,
          "error"
        );
        return;
      }
      setStatus(scoreStatus, "评分通过校验", "ok");
      renderFeedback(body);
      if (currentQuestionId) await refreshAttemptHistory(currentQuestionId);
      setTimeout(() => setScoreFormVisible(false), 200);
    } catch (error) {
      setStatus(scoreStatus, `评分失败: ${error?.message ?? error}`, "error");
    }
  });
}

document.querySelector("[data-llm-score]")?.addEventListener("click", async () => {
  setStatus(attemptStatus, "", null);
  if (!lastAttemptId) {
    setStatus(attemptStatus, "请先保存一次回答,然后再点 LLM 评分", "error");
    return;
  }
  setStatus(attemptStatus, "正在调用 LLM 评分...", "ok");
  try {
    const response = await fetch(
      `/api/attempts/${encodeURIComponent(lastAttemptId)}/llm-score`,
      { method: "POST" }
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const where = body?.path ? ` (${body.path})` : "";
      setStatus(
        attemptStatus,
        `LLM 评分失败: ${body?.error ?? `HTTP ${response.status}`}${where} · 可改用粘贴 JSON`,
        "error"
      );
      return;
    }
    setStatus(attemptStatus, "LLM 评分通过校验", "ok");
    renderFeedback(body);
    if (currentQuestionId) await refreshAttemptHistory(currentQuestionId);
  } catch (error) {
    setStatus(
      attemptStatus,
      `LLM 评分失败: ${error?.message ?? error} · 可改用粘贴 JSON`,
      "error"
    );
  }
});

// ---------------------------------------------------------------------------
// Step 7: save as official card (sidebar form + top-of-detail button)
// ---------------------------------------------------------------------------

const saveCardForm = document.querySelector("[data-save-card-form]");
const saveCardBtn = saveCardForm?.querySelector("[data-save-card-btn]");
const saveCardTopBtn = document.querySelector("[data-save-card-top]");
const saveStatus = document.querySelector("[data-save-status]");
const saveHint = document.querySelector("[data-save-preview-hint]");
const saveCheckScore = document.querySelector("[data-save-check-score]");

function updateSavePreview({ question, bestAttempt }) {
  bestAttemptForSave = bestAttempt ?? null;

  if (!question) {
    if (saveHint) saveHint.textContent = "请先从题目库选择一个问题。";
    if (saveCardBtn) saveCardBtn.disabled = true;
    if (saveCardTopBtn) saveCardTopBtn.disabled = true;
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
    if (saveCardTopBtn) saveCardTopBtn.disabled = true;
    if (saveCheckScore) {
      saveCheckScore.textContent = "还没有通过校验的评分";
      saveCheckScore.className = "warn";
    }
    return;
  }
  const total = totalScoreClient(bestAttempt.summary);
  const totalLabel = total === null ? "—" : total.toFixed(1);
  if (saveHint) {
    saveHint.textContent = `将保存最佳回答 (${totalLabel} / 10),分类和难度可在下面调整。`;
  }
  if (saveCardBtn) saveCardBtn.disabled = false;
  if (saveCardTopBtn) saveCardTopBtn.disabled = false;
  if (saveCheckScore) {
    saveCheckScore.textContent = `最佳评分 ${totalLabel}`;
    saveCheckScore.className = "ok";
  }
}

async function submitSaveCard() {
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
      // The backend removes the question from the pool on a successful
      // save; clear the persisted pointer so a refresh does not bounce
      // the user back to a now-empty practice page.
      setCurrentQuestionIdState(null);
      refreshQuestionPool(lastKnownQuery).catch(() => {});
      return;
    }
    if (!response.ok) {
      setStatus(saveStatus, `保存失败: ${body?.error ?? `HTTP ${response.status}`}`, "error");
      return;
    }
    setStatus(saveStatus, `已保存卡片: ${body.id}`, "ok");
    setCurrentQuestionIdState(null);
    refreshQuestionPool(lastKnownQuery).catch(() => {});
  } catch (error) {
    setStatus(saveStatus, `保存失败: ${error?.message ?? error}`, "error");
  }
}

if (saveCardForm) {
  saveCardForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitSaveCard();
  });
}
saveCardTopBtn?.addEventListener("click", () => submitSaveCard());

// ---------------------------------------------------------------------------
// Step 8: NowCoder fetch
// ---------------------------------------------------------------------------

const nowcoderForm = document.getElementById("nowcoder-fetch-form");
const nowcoderStatus = nowcoderForm?.querySelector("[data-source-status]");
const nowcoderHint = document.querySelector("[data-nowcoder-hint]");

if (nowcoderForm) {
  nowcoderForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(nowcoderStatus, "正在自动抓题...", "ok");
    const data = new FormData(nowcoderForm);
    const query = String(data.get("query") ?? "").trim();
    // empty query is allowed — server treats it as 面经 feed mode.
    // maxArticles is no longer a UI knob; the server pins it to 2.
    try {
      const response = await fetch("/api/sources/nowcoder/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setStatus(
          nowcoderStatus,
          `抓取失败: ${body?.error ?? `HTTP ${response.status}`} · 可切换到"手动粘贴"继续`,
          "error"
        );
        if (nowcoderHint) nowcoderHint.textContent = "抓取失败不会影响手动粘贴链路。";
        return;
      }
      const savedArticleCount = body?.savedArticles?.length ?? body?.saved?.length ?? 0;
      const savedQuestionCount = body?.savedQuestions?.length ?? 0;
      const failedCount = body?.failed?.length ?? 0;
      const skippedCount = body?.skippedUrls?.length ?? body?.skipped?.length ?? 0;
      const classifiedNo = body?.classifiedNo ?? 0;
      const pruned = body?.prunedArticles ?? 0;
      const purgedIgnored = Number.isInteger(body?.purgedIgnored) ? body.purgedIgnored : 0;
      const diagnostics = body?.diagnostics ?? null;
      const exhaustedToday = body?.exhaustedToday === true;
      const parts = [`已新增 ${savedQuestionCount} 个问题`];
      parts.push(`抓 ${savedArticleCount} 篇`);
      if (skippedCount > 0) parts.push(`跳过旧链接 ${skippedCount}`);
      if (classifiedNo > 0) parts.push(`非面经 ${classifiedNo}`);
      if (diagnostics?.extractionSkippedReason === "LLM_NOT_CONFIGURED") {
        parts.push("未配置 LLM,仅保存文章");
      } else if (diagnostics) {
        if (diagnostics.extractionAttempted > 0) {
          parts.push(`抽题 ${diagnostics.extractionAttempted} 篇`);
        }
        if (diagnostics.extractionNoQuestions > 0) {
          parts.push(`无题 ${diagnostics.extractionNoQuestions} 篇`);
        }
      }
      if (failedCount > 0) parts.push(`${failedCount} 失败`);
      if (pruned > 0) parts.push(`已清理 ${pruned} 篇过期`);
      if (purgedIgnored > 0) parts.push(`已清理 ${purgedIgnored} 条忽略`);
      if (exhaustedToday) parts.push("今天的牛客池子已抓完,明天再试或换关键词");
      const tone = exhaustedToday
        ? "ok"
        : savedQuestionCount > 0 || savedArticleCount > 0
          ? "ok"
          : "error";
      setStatus(nowcoderStatus, parts.join(" · "), tone);
      if (body?.classifyError) {
        setStatus(
          nowcoderStatus,
          `${parts.join(" · ")} · 标题分类失败,本批整批跳过`,
          "error"
        );
      }
      const partition = body?.partitionQuery ?? (query === "" ? "__feed__" : query);
      setLastKnownQuery(partition);
      await refreshQuestionPool(lastKnownQuery);
    } catch (error) {
      setStatus(
        nowcoderStatus,
        `抓取失败: ${error?.message ?? error} · 可切换到"手动粘贴"继续`,
        "error"
      );
    }
  });
}

// ---------------------------------------------------------------------------
// 卡片库 view
// ---------------------------------------------------------------------------

async function refreshCardsView() {
  const grid = document.querySelector("[data-cards-grid]");
  if (!grid) return;
  try {
    const response = await fetch("/api/cards");
    if (!response.ok) {
      grid.innerHTML = `
        <article class="training-card add-card">
          <strong>·</strong>
          <h4>读取卡片库失败</h4>
          <p>请检查 server 状态或 cards/ 目录权限。</p>
        </article>`;
      return;
    }
    const body = await response.json();
    const cards = body.cards ?? [];
    if (cards.length === 0) {
      grid.innerHTML = `
        <article class="training-card add-card">
          <strong>·</strong>
          <h4>还没有保存的卡片</h4>
          <p>在练习详情页通过 LLM 评分后,可以保存最佳回答为正式卡片。</p>
        </article>`;
      return;
    }
    grid.innerHTML = cards
      .map((card) => {
        const scores = card.feedback?.performanceScore?.scores ?? {};
        const total = totalScoreClient({ scores });
        const totalLabel = total === null ? "—" : total.toFixed(1);
        return `<article class="training-card mastered" data-card-id="${escapeHtml(card.id)}">
          <div class="card-topline">
            <span>${escapeHtml(card.category)}</span>
            <em>${escapeHtml(card.difficulty)}</em>
          </div>
          <h4>${escapeHtml(card.title)}</h4>
          <p>${escapeHtml((card.feedback?.performanceScore?.overallComment ?? "").slice(0, 80))}</p>
          <div class="score-row">
            <span>${totalLabel} / 10</span>
            <span>${escapeHtml(card.updatedAt ?? card.createdAt ?? "")}</span>
          </div>
        </article>`;
      })
      .join("");
  } catch (error) {
    console.warn("refreshCardsView failed", error);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
//
// Restore navigation state from localStorage + URL hash so a refresh keeps
// the user on the same partition / view / question. The backend stays the
// source of truth for everything else.

(function bootRestore() {
  const storedQuery = safeStorageGet(STORAGE_KEYS.lastKnownQuery);
  if (storedQuery && typeof storedQuery === "string" && storedQuery.length > 0) {
    lastKnownQuery = storedQuery;
  } else {
    // Fall back to the manual-import form's query input on first run only.
    const manualDefault =
      importForm?.querySelector("[name=query]")?.value?.trim() || "__feed__";
    lastKnownQuery = manualDefault;
  }

  refreshQuestionPool(lastKnownQuery).catch(() => {});

  const hashView = (() => {
    const raw = (window.location?.hash ?? "").replace(/^#/, "");
    return VALID_VIEWS.has(raw) ? raw : "home";
  })();

  if (hashView === "practice") {
    const storedQuestionId = safeStorageGet(STORAGE_KEYS.currentQuestionId);
    if (storedQuestionId) {
      // setActivePracticeQuestion handles stale ids: if the question is
      // gone (purged / saved as card / never existed), it clears the
      // pointer and bounces back to home.
      showView("practice", { questionId: storedQuestionId });
    } else {
      showView("home");
    }
  } else if (hashView === "cards") {
    showView("cards");
  } else {
    showView("home");
  }
})();
