// ps-select: progressive-enhancement custom listbox over native <select>.
// The native <select> stays in the DOM as the source of truth (forms, htmx, a11y fallback); we hide
// it and drive it from a styled trigger + panel. On pick we set select.value and dispatch a bubbling
// 'change' so htmx (hx-put on the select, default trigger=change) fires exactly as before. No-JS or a
// load failure leaves the native styled select fully working. Re-runs after every htmx swap.
(function () {
  "use strict";
  var CHEV =
    '<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  var CHECK =
    '<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  function closeAll(except) {
    document.querySelectorAll(".ps-select.open").forEach(function (s) {
      if (s === except) return;
      s.classList.remove("open");
      var t = s.querySelector(".ps-trigger");
      if (t) t.setAttribute("aria-expanded", "false");
    });
  }

  function build(select) {
    if (select.dataset.psEnhanced || select.hasAttribute("data-ps-raw") || select.multiple) return;
    select.dataset.psEnhanced = "1";

    var wrap = document.createElement("div");
    wrap.className = "ps-select";
    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "ps-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    var lbl = select.getAttribute("aria-label");
    if (lbl) trigger.setAttribute("aria-label", lbl);
    var val = document.createElement("span");
    val.className = "val";
    trigger.appendChild(val);
    trigger.insertAdjacentHTML("beforeend", CHEV);

    var panel = document.createElement("div");
    panel.className = "ps-panel";
    panel.setAttribute("role", "listbox");

    var optEls = [].map.call(select.options, function (o, i) {
      var el = document.createElement("div");
      el.className = "ps-opt";
      el.setAttribute("role", "option");
      if (o.disabled) el.setAttribute("aria-disabled", "true");
      el.innerHTML = CHECK;
      var span = document.createElement("span");
      span.textContent = o.textContent;
      if (!o.value) span.className = "muted";
      el.appendChild(span);
      el.addEventListener("mouseenter", function () { setActive(i); });
      el.addEventListener("mousedown", function (e) { e.preventDefault(); }); // keep focus on trigger
      el.addEventListener("click", function (e) { e.stopPropagation(); pick(i); });
      panel.appendChild(el);
      return el;
    });

    var active = select.selectedIndex < 0 ? 0 : select.selectedIndex;

    function syncLabel() {
      var o = select.options[select.selectedIndex];
      val.textContent = o ? o.textContent : "";
      val.classList.toggle("is-placeholder", !!o && !o.value);
      optEls.forEach(function (e, j) {
        if (j === select.selectedIndex) e.setAttribute("aria-selected", "true");
        else e.removeAttribute("aria-selected");
      });
    }
    function setActive(i) {
      active = (i + optEls.length) % optEls.length;
      optEls.forEach(function (e, j) { e.classList.toggle("active", j === active); });
      optEls[active].scrollIntoView({ block: "nearest" });
    }
    function position() {
      // Fixed positioning so the panel escapes any overflow:auto ancestor (e.g. scrollable tables).
      var r = trigger.getBoundingClientRect();
      panel.style.minWidth = r.width + "px";
      panel.style.left = Math.round(r.left) + "px";
      var ph = panel.offsetHeight;
      var below = window.innerHeight - r.bottom;
      if (below < ph + 10 && r.top > below) panel.style.top = Math.round(r.top - ph - 6) + "px";
      else panel.style.top = Math.round(r.bottom + 6) + "px";
    }
    // Keep the fixed panel glued to the trigger while the page scrolls — instead of CLOSING on scroll,
    // which (with capture:true) also fired for scrolling INSIDE the panel and shut it before you could
    // reach a lower option. The panel has its own max-height + overflow, so inner scroll just works.
    function reposition() { if (wrap.classList.contains("open")) position(); }
    function open() {
      if (select.disabled) return;
      closeAll(wrap);
      wrap.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
      position();
      setActive(select.selectedIndex < 0 ? 0 : select.selectedIndex);
      window.addEventListener("scroll", reposition, true);
      window.addEventListener("resize", reposition);
    }
    function close() {
      if (!wrap.classList.contains("open")) return;
      wrap.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    }
    function pick(i) {
      if (select.options[i] && select.options[i].disabled) return;
      if (select.selectedIndex !== i) {
        select.selectedIndex = i;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      syncLabel();
      close();
      trigger.focus();
    }

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (wrap.classList.contains("open")) close();
      else open();
    });
    trigger.addEventListener("keydown", function (e) {
      var openKeys = e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ";
      if (!wrap.classList.contains("open")) {
        if (openKeys) { e.preventDefault(); open(); }
        return;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(active); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Tab") { close(); }
    });
    select.addEventListener("change", syncLabel); // keep in sync if value is changed elsewhere

    if (select.disabled) wrap.classList.add("is-disabled");
    select.classList.add("ps-native-hidden");
    select.setAttribute("tabindex", "-1");
    select.setAttribute("aria-hidden", "true");
    select.parentNode.insertBefore(wrap, select.nextSibling);
    wrap.appendChild(trigger);
    wrap.appendChild(panel);
    syncLabel();
  }

  function enhanceAll(root) {
    (root || document).querySelectorAll("select:not([data-ps-enhanced])").forEach(build);
  }

  document.addEventListener("click", function () { closeAll(); });
  document.addEventListener("htmx:afterSwap", function (e) { enhanceAll(e.target); });
  if (document.readyState !== "loading") enhanceAll();
  else document.addEventListener("DOMContentLoaded", function () { enhanceAll(); });
})();
