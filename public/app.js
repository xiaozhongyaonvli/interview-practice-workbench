// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

const views = document.querySelectorAll("[data-view]");
const navLinks = document.querySelectorAll("[data-view-link]");

function showView(name) {
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
    showView("practice");
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
