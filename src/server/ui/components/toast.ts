import { html, raw } from "hono/html";
import type { Context } from "hono";

type Html = ReturnType<typeof html>;

export type ToastTone = "ok" | "warn" | "bad" | "info";

/**
 * Attach an `HX-Trigger` header that fires a `ps:toast` client event carrying a
 * toast payload. The Alpine listener in the shell renders it in the `.toasts`
 * region. No-JS clients (303 redirect path) simply never see this header.
 *
 * `msg` is plain text — it is rendered with Alpine `x-text` (textContent), so it
 * is never interpreted as HTML even if it echoes provider/user strings.
 */
export function toastHeader(c: Context, tone: ToastTone, msg: string): void {
  c.header("HX-Trigger", JSON.stringify({ "ps:toast": { tone, msg } }));
}

/** Whether this request was issued by HTMX (vs a plain no-JS form submit / navigation). */
export function isHtmx(c: Context): boolean {
  return c.req.header("HX-Request") === "true";
}

/**
 * The toast region template + the confirm dialog, rendered once in the shell.
 * Both are Alpine-driven and live inside the `<body x-data>` scope. The region
 * itself already exists (aria-live) — this fills it with an x-for of live toasts
 * and adds the styled confirm dialog used in place of native confirm().
 */
export function toastRegion(): Html {
  return html`<div class="toasts" role="status" aria-live="polite" aria-atomic="false">
    <template x-for="t in $store.ui.toasts" :key="t.id">
      <div class="toast" :class="'tone-' + t.tone" role="alert" x-transition.opacity.duration.150ms>
        <span class="toast-dot" :class="'tone-' + t.tone" aria-hidden="true"></span>
        <span class="toast-msg" x-text="t.msg"></span>
        <button type="button" class="toast-x" aria-label="Dismiss" @click="$store.ui.dismiss(t.id)">
          <svg class="ico" width="13" height="13" aria-hidden="true"><use href="#i-close" /></svg>
        </button>
      </div>
    </template>
  </div>`;
}

/**
 * The shared styled confirm dialog (replaces native confirm() on destructive HTMX actions).
 * Focus-trapped + Esc/Cancel via the `psTrap` Alpine directive defined in uiBehaviorScript
 * (no Alpine Focus plugin needed). `x-show` toggles it; the danger button resumes the request.
 */
export function confirmDialog(): Html {
  return html`<div
    class="confirm-overlay"
    x-show="$store.ui.confirm.open"
    x-cloak
    @keydown.escape.window="$store.ui.cancelConfirm()"
    @click.self="$store.ui.cancelConfirm()"
    x-transition.opacity.duration.120ms
  >
    <div
      class="confirm-card"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="ps-confirm-title"
      aria-describedby="ps-confirm-body"
      x-pstrap="$store.ui.confirm.open"
    >
      <h2 class="confirm-title" id="ps-confirm-title" x-text="$store.ui.confirm.title"></h2>
      <p class="confirm-body" id="ps-confirm-body" x-text="$store.ui.confirm.body"></p>
      <div class="confirm-acts">
        <button type="button" class="btn btn-ghost btn-md" @click="$store.ui.cancelConfirm()">
          Cancel
        </button>
        <button type="button" class="btn btn-danger btn-md" @click="$store.ui.acceptConfirm()" x-text="$store.ui.confirm.label"></button>
      </div>
    </div>
  </div>`;
}

/**
 * The Alpine `$store.ui` definition + a self-contained focus-trap directive (`x-pstrap`)
 * + the HTMX glue (toast on HX-Trigger, styled confirm on htmx:confirm). Loaded once by the
 * shell. Progressive enhancement only: with JS off none of this runs and the POST→redirect
 * forms keep working (destructive ones simply submit, as native confirm also needs JS).
 *
 * Static literal — no interpolation of any request/DB value (so raw() is safe).
 */
export function uiBehaviorScript(): Html {
  return html`${raw(`<script>
(function () {
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  document.addEventListener('alpine:init', function () {
    Alpine.store('ui', {
      toasts: [],
      _seq: 0,
      push: function (tone, msg) {
        var id = ++this._seq;
        this.toasts.push({ id: id, tone: tone || 'info', msg: String(msg || '') });
        var self = this;
        setTimeout(function () { self.dismiss(id); }, 4200);
      },
      dismiss: function (id) {
        this.toasts = this.toasts.filter(function (t) { return t.id !== id; });
      },
      confirm: { open: false, title: '', body: '', label: 'Confirm', _resume: null },
      ask: function (opts, resume) {
        this.confirm = {
          open: true,
          title: opts.title || 'Are you sure?',
          body: opts.body || '',
          label: opts.label || 'Confirm',
          _resume: resume || null,
        };
      },
      acceptConfirm: function () {
        var r = this.confirm._resume;
        this.confirm.open = false;
        this.confirm._resume = null;
        if (r) r();
      },
      cancelConfirm: function () {
        this.confirm.open = false;
        this.confirm._resume = null;
      },
    });

    // x-pstrap="<expr>": when <expr> is truthy, trap Tab focus inside the element + focus
    // its first control; restore focus to the prior element when it closes. Esc is handled
    // by the owning component. A dependency-free stand-in for the Alpine Focus plugin.
    Alpine.directive('pstrap', function (el, info, ctx) {
      var prev = null;
      function nodes() {
        return Array.prototype.slice.call(el.querySelectorAll(FOCUSABLE)).filter(function (n) {
          return n.offsetParent !== null;
        });
      }
      function onKey(e) {
        if (e.key !== 'Tab') return;
        var f = nodes();
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      ctx.effect(function () {
        var open = !!ctx.evaluate(info.expression);
        if (open) {
          prev = document.activeElement;
          el.addEventListener('keydown', onKey);
          requestAnimationFrame(function () { var f = nodes(); if (f.length) f[0].focus(); });
        } else {
          el.removeEventListener('keydown', onKey);
          if (prev && prev.focus) prev.focus();
          prev = null;
        }
      });
    });
  });

  // Body-scoped HTMX listeners — attached only once the body exists.
  function wireBody() {
    // HTMX → toast: fire from a server HX-Trigger {"ps:toast":{tone,msg}}.
    document.body.addEventListener('ps:toast', function (e) {
      var d = (e && e.detail) || {};
      if (window.Alpine && Alpine.store('ui')) Alpine.store('ui').push(d.tone, d.msg);
    });
    // HTMX confirm → styled Alpine dialog (only for elements carrying hx-confirm).
    document.body.addEventListener('htmx:confirm', function (e) {
      if (!e.detail || !e.detail.question) return; // no hx-confirm → native flow
      e.preventDefault();
      var el = e.detail.elt;
      var label = (el && el.getAttribute('data-confirm-label')) || 'Confirm';
      if (window.Alpine && Alpine.store('ui')) {
        Alpine.store('ui').ask(
          { title: 'Please confirm', body: e.detail.question, label: label },
          function () { e.detail.issueRequest(true); }
        );
      } else {
        e.detail.issueRequest(false); // Alpine missing → native confirm
      }
    });
  }
  if (document.body) wireBody();
  else document.addEventListener('DOMContentLoaded', wireBody);
})();
</script>`)}`;
}
