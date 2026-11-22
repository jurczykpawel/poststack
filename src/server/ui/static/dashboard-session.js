(function () {
  try { window.localStorage.removeItem("htmx-history-cache"); } catch { /* Storage may be disabled. */ }
  window.addEventListener("pagehide", function () {
    document.documentElement.style.visibility = "hidden";
  });
  window.addEventListener("pageshow", function (event) {
    document.documentElement.style.visibility = "";
    if (event.persisted) window.location.reload();
  });
})();
