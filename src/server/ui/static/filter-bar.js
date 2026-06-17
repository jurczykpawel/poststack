// Auto-applying filter bars (UXPOLISH1). Any `form.filter-bar` applies on interaction instead of
// requiring an "Apply" click: selects submit on change, a search box submits debounced as you type
// (and on Enter, natively). Progressive enhancement — the submit button still works with no JS, but
// we hide it once wired so the bar feels like the inbox's instant filters.
(function () {
  var DEBOUNCE_MS = 400;

  function apply(form) {
    if (form.requestSubmit) form.requestSubmit();
    else form.submit();
  }

  function wire(form) {
    if (form.dataset.fbWired) return;
    form.dataset.fbWired = "1";

    // Selects (native or ps-select-enhanced — both dispatch a bubbling 'change') apply immediately.
    form.addEventListener("change", function (e) {
      var t = e.target;
      if (t && t.tagName === "SELECT") apply(form);
    });

    // Search box: apply after the user pauses typing (and Enter submits natively).
    var search = form.querySelector('input[type="search"]');
    if (search) {
      search.addEventListener("input", function () {
        window.clearTimeout(search._fbT);
        search._fbT = window.setTimeout(function () { apply(form); }, DEBOUNCE_MS);
      });
    }

    // The Apply button is now redundant — hide it (kept in the DOM as the no-JS fallback).
    var submit = form.querySelector('button[type="submit"], input[type="submit"]');
    if (submit) submit.style.display = "none";
  }

  function wireAll(root) {
    (root || document).querySelectorAll("form.filter-bar").forEach(wire);
  }

  if (document.readyState !== "loading") wireAll();
  else document.addEventListener("DOMContentLoaded", function () { wireAll(); });
  // Re-wire after htmx swaps (a filter bar re-rendered into the page stays auto-applying).
  if (document.body) document.body.addEventListener("htmx:afterSwap", function (e) { wireAll(e.target); });
})();
