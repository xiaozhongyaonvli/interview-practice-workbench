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

  window.scrollTo({ top: 0, behavior: "smooth" });
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
