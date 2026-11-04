// Client side of the shared DataList (components/data-list.ts). Everything else is server-rendered.
(function () {
  var returnTo = null;

  function ready() {
    // Empty filter fields would otherwise end up in the pushed address.
    document.body.addEventListener("htmx:configRequest", function (e) {
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

    // Closing details hands focus back to the row they belong to.
    document.body.addEventListener("click", function (e) {
      var close = e.target.closest && e.target.closest(".dl-close");
      if (close) returnTo = close.getAttribute("data-row-return");
    });
    document.body.addEventListener("htmx:afterSettle", function (e) {
      if (!returnTo || e.target !== document.getElementById("data-list") || document.querySelector(".dl-detail")) return;
      var id = returnTo;
      returnTo = null;
      var row = Array.from(document.querySelectorAll("[data-row]")).find(function (r) { return r.getAttribute("data-row") === id; });
      var link = row && row.querySelector("a.dl-rowlink");
      if (link) link.focus({ preventScroll: true });
    });
  }

  if (document.body) ready();
  else document.addEventListener("DOMContentLoaded", ready);
})();
