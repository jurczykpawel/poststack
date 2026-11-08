// Client side of the shared DataList (components/data-list.ts). Everything else is server-rendered.
(function () {
  var returnTo = new window.URL(window.location.href).searchParams.get("open");

  function restoreFocus(clear) {
    if (!returnTo || document.querySelector(".dl-detail, #thread .thread-head")) return;
    var row = Array.from(document.querySelectorAll("[data-row]")).find(function (r) { return r.getAttribute("data-row") === returnTo; });
    var link = row && (row.matches(".conv-item") ? row : row.querySelector("a.dl-rowlink"));
    if (link) link.focus({ preventScroll: !row.matches(".conv-item") });
    if (clear) returnTo = null;
  }

  function ready() {
    // Empty filter fields would otherwise end up in the pushed address.
    document.body.addEventListener("htmx:configRequest", function (e) {
      if (e.target.id === "conv-panel" || (e.target.id === "conv-filter-form" && ["htmx:historyRestore", "conversation-updated"].includes(e.detail.triggeringEvent?.type))) {
        var inboxUrl = new window.URL(window.location.href);
        e.detail.formData.set("pages", inboxUrl.searchParams.get("pages") || "1");
        e.detail.headers["X-Inbox-Refresh"] = "true";
        if (e.target.id === "conv-panel") e.detail.path = "/inbox/list" + inboxUrl.search;
      }
      if (!e.target.closest || !e.target.closest("#data-list")) return;
      var form = e.detail.formData;
      Array.from(form.keys()).forEach(function (k) {
        if (form.get(k) === "") form.delete(k);
      });
    });

    // A reply to older keystrokes must not overwrite what is in the search box now.
    document.body.addEventListener("htmx:beforeSwap", function (e) {
      var box = document.activeElement;
      var sender = e.detail.requestConfig && e.detail.requestConfig.elt;
      if (!box || box.id !== "dl-search" || !sender || sender.tagName !== "FORM") return;
      var q = e.detail.requestConfig.formData.get("q") || "";
      if (q !== box.value.trim()) e.detail.shouldSwap = false;
    });

    document.body.addEventListener("htmx:historyRestore", function () { restoreFocus(false); });

    // Closing details hands focus back to the row they belong to.
    document.body.addEventListener("click", function (e) {
      var conversation = e.target.closest && e.target.closest(".conv-item");
      if (conversation) returnTo = conversation.getAttribute("data-row");
      var close = e.target.closest && e.target.closest(".dl-close, .thread-back");
      if (close) {
        returnTo = close.getAttribute("data-row-return");
        if (close.matches(".thread-back") && !window.history.state?.htmx) requestAnimationFrame(function () { restoreFocus(true); });
      }
    });
    document.body.addEventListener("htmx:afterSettle", function (e) {
      if (e.target !== document.getElementById("data-list") && e.target !== document.getElementById("conv-panel")) return;
      restoreFocus(true);
    });
  }

  if (document.body) ready();
  else document.addEventListener("DOMContentLoaded", ready);
})();
