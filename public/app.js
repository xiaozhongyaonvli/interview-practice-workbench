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

document.querySelectorAll("[data-open-practice]").forEach((button) => {
  button.addEventListener("click", () => showView("practice"));
});

document.querySelectorAll("[data-back-home]").forEach((button) => {
  button.addEventListener("click", () => showView("home"));
});

navLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showView(link.dataset.viewLink);
  });
});

// ---------------------------------------------------------------------------
// Step 2: manual article import (sidebar source-box + recent imports list)
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
  tab.addEventListener("click", () => {
    showSourcePanel(tab.dataset.sourceTab);
  });
});

const importForm = document.getElementById("manual-import-form");
const importStatus = importForm
  ? importForm.querySelector("[data-source-status]")
  : null;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setImportStatus(message, tone) {
  if (!importStatus) return;
  if (!message) {
    importStatus.hidden = true;
    importStatus.textContent = "";
    importStatus.removeAttribute("data-source-status-tone");
    return;
  }
  importStatus.hidden = false;
  importStatus.textContent = message;
  if (tone) {
    importStatus.dataset.sourceStatusTone = tone;
  }
}

function renderImportedList(articles) {
  const list = document.querySelector("[data-imported-list]");
  if (!list) return;
  if (!Array.isArray(articles) || articles.length === 0) {
    list.innerHTML = '<li class="imported-empty">还没有导入的文章</li>';
    return;
  }
  // Show the most recent 5; ArticleStore appends in chronological order, so
  // the last entries are the freshest.
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
    // jsdom or offline environments may reject fetch; keep page usable.
    console.warn("refreshImportedList failed", error);
  }
}

if (importForm) {
  importForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setImportStatus("", null);

    const formData = new FormData(importForm);
    const payload = {
      query: String(formData.get("query") ?? "").trim(),
      title: String(formData.get("title") ?? "").trim(),
      text: String(formData.get("text") ?? "")
    };

    // Front-end pre-check: surface the obvious user mistakes immediately.
    // The server still performs the authoritative validation.
    if (!payload.query) {
      setImportStatus("方向不能为空", "error");
      return;
    }
    if (!payload.title) {
      setImportStatus("标题不能为空", "error");
      return;
    }
    if (!payload.text.trim()) {
      setImportStatus("正文不能为空", "error");
      return;
    }

    try {
      const response = await fetch("/api/articles/manual", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const reason = body?.error ?? `HTTP ${response.status}`;
        setImportStatus(`保存失败: ${reason}`, "error");
        return;
      }
      setImportStatus(`已保存: ${body?.title ?? payload.title}`, "ok");
      // Clear title + text but keep the query for the next paste.
      const titleField = importForm.querySelector("[name=title]");
      const textField = importForm.querySelector("[name=text]");
      if (titleField) titleField.value = "";
      if (textField) textField.value = "";
      await refreshImportedList(payload.query);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      setImportStatus(`保存失败: ${message}`, "error");
    }
  });

  const initialQuery =
    importForm.querySelector("[name=query]")?.value?.trim() || "mysql";
  // Best-effort initial fetch — never throw on failure.
  refreshImportedList(initialQuery).catch(() => {});
}
