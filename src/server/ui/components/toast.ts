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
  const payload = JSON.stringify({ "ps:toast": { tone, msg } })
    .replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  c.header("HX-Trigger", payload);
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

/** Shared modal confirmation for HTMX actions. The browser handles Escape and focus return. */
export function confirmDialog(): Html {
  return html`<dialog
    class="confirm-overlay"
    role="alertdialog"
    aria-labelledby="ps-confirm-title"
    aria-describedby="ps-confirm-body"
    x-pstrap.tab-only
    x-effect="$store.ui.confirm.open ? ($el.open || $el.showModal()) : ($el.open && $el.close())"
    @close="if (!$el.open) $store.ui.cancelConfirm()"
    @click.self="$el.close()"
  >
    <div class="confirm-card">
      <h2 class="confirm-title" id="ps-confirm-title" x-text="$store.ui.confirm.title"></h2>
      <p class="confirm-body" id="ps-confirm-body" x-text="$store.ui.confirm.body"></p>
      <div class="confirm-acts">
        <button type="button" class="btn btn-ghost btn-md" autofocus @click="$el.closest('dialog').close()">
          Cancel
        </button>
        <button type="button" class="btn btn-danger btn-md" @click="$store.ui.acceptConfirm()" x-text="$store.ui.confirm.label"></button>
      </div>
    </div>
  </dialog>`;
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
        document.querySelector('.confirm-overlay[open]')?.close();
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
      // Native dialogs manage initial focus and restore it on close, but Tab can reach browser UI.
      if (info.modifiers.includes('tab-only')) {
        el.addEventListener('keydown', onKey);
        ctx.cleanup(function () { el.removeEventListener('keydown', onKey); });
        return;
      }
      ctx.effect(function () {
        var open = !!ctx.evaluate(info.expression);
        if (open) {
          prev = document.activeElement;
          el.addEventListener('keydown', onKey);
          requestAnimationFrame(function () { var f = nodes(); if (f.length) f[0].focus(); });
        } else {
          el.removeEventListener('keydown', onKey);
          if (el.dataset.focusReturn && prev) {
            var target = document.querySelector(el.dataset.focusReturn);
            if (target) requestAnimationFrame(function () { target.focus(); });
          } else if (prev && prev.focus) prev.focus();
          prev = null;
        }
      });
    });
  });

  // Body-scoped HTMX listeners — attached only once the body exists.
  function wireBody() {
    var shell = document.querySelector('.app[sse-connect]');
    var realtimePaused = false;
    function pauseRealtime() {
      if (!shell || realtimePaused) return;
      realtimePaused = true;
      // Reuse the SSE extension's cleanup before the browser tears down its connection.
      htmx.trigger(shell, 'htmx:beforeCleanupElement');
    }
    window.addEventListener('pageswap', pauseRealtime);
    window.addEventListener('pagehide', pauseRealtime);
    window.addEventListener('pageshow', function (e) {
      if (!shell || !realtimePaused || !e.persisted) return;
      realtimePaused = false;
      htmx.trigger(shell, 'htmx:afterProcessNode');
      shell.querySelectorAll('[hx-trigger], [sse-swap]').forEach(function (el) {
        htmx.trigger(el, 'htmx:afterProcessNode');
      });
    });
    // An open modal makes the rest of the page inert, so page toasts would be neither reachable nor
    // reliably announced. Messages from the modal's own requests go to a live region inside it; the
    // others wait for it to close.
    var deferred = [];
    var TONE_CLASS = { bad: 'notice-err', warn: 'notice-warn', ok: 'notice-ok', info: 'notice-info' };
    function whenClosed(modal) {
      if (modal._psWatched) return;
      modal._psWatched = true;
      modal.addEventListener('close', function () {
        modal._psWatched = false;
        var feedback = modal.querySelector('.modal-feedback');
        if (feedback) {
          feedback.remove();
          // A modal that closes right after its save hands the confirmation to the page.
          if (/^(ok|info)$/.test(feedback.dataset.tone) && Date.now() - Number(feedback.dataset.at) < 4200) {
            deferred.unshift([feedback.dataset.tone, feedback.dataset.msg]);
          }
        }
        deferred.splice(0).forEach(function (d) { notify(d[0], d[1]); });
      }, { once: true });
    }
    function notify(tone, message, source) {
      tone = TONE_CLASS[tone] ? tone : 'info';
      message = String(message || '');
      var modal = source?.closest?.('dialog:modal');
      if (modal) {
        modal.querySelector('.modal-feedback')?.remove();
        var failed = tone === 'bad' || tone === 'warn';
        var feedback = document.createElement('p');
        feedback.className = 'notice modal-feedback ' + TONE_CLASS[tone];
        feedback.setAttribute('role', failed ? 'alert' : 'status');
        feedback.dataset.tone = tone;
        feedback.dataset.msg = message;
        feedback.dataset.at = String(Date.now());
        modal.prepend(feedback);
        // Filled after insertion, so screen readers announce it as a change to a live region.
        requestAnimationFrame(function () { feedback.textContent = message; });
        whenClosed(modal);
        return;
      }
      var open = document.querySelector('dialog:modal');
      if (open) {
        deferred.push([tone, message]);
        whenClosed(open);
      } else if (window.Alpine && Alpine.store('ui')) {
        // Also releases messages left behind by a modal removed from the page without closing.
        deferred.splice(0).concat([[tone, message]]).forEach(function (d) { Alpine.store('ui').push(d[0], d[1]); });
      }
    }
    document.body.addEventListener('htmx:beforeRequest', function (e) {
      if (e.detail.requestConfig.verb !== 'get') e.target.closest('dialog:modal')?.querySelector('.modal-feedback')?.remove();
    });
    document.body.addEventListener('htmx:beforeSwap', function (e) {
      var xhr = e.detail.xhr;
      if ((xhr.status === 409 && xhr.getResponseHeader('HX-Reswap') === 'outerHTML') ||
          (xhr.status === 429 && xhr.getResponseHeader('HX-Retarget') && xhr.getResponseHeader('HX-Reswap'))) {
        e.detail.shouldSwap = true;
      }
    });
    // HTMX → toast: fire from a server HX-Trigger {"ps:toast":{tone,msg}}.
    document.body.addEventListener('ps:toast', function (e) {
      var d = (e && e.detail) || {};
      notify(d.tone, d.msg, e.target);
    });
    // MQA18-B04: a failed htmx write must never look saved. Network failure → sendError; a 5xx (or an
    // error the server did not already explain with its own toast) → responseError. GET polls stay silent.
    function writeFailed(e, fallback) {
      var d = e.detail || {};
      if (((d.requestConfig && d.requestConfig.verb) || 'get') === 'get') return;
      notify('bad', fallback, d.elt);
    }
    document.body.addEventListener('htmx:sendError', function (e) {
      writeFailed(e, 'Not saved — no connection. Check your network and try again.');
    });
    document.body.addEventListener('htmx:responseError', function (e) {
      var xhr = (e.detail || {}).xhr;
      // A 422 is swapped into the form's own message slot, so it is explained already (MQA19-B04).
      var explained = xhr && (xhr.status === 422 ||
        (xhr.status === 429 && xhr.getResponseHeader('HX-Retarget')) ||
        /ps:toast/.test(xhr.getResponseHeader('HX-Trigger') || ''));
      if (!explained) writeFailed(e, xhr?.status === 429
        ? 'Too many requests. Wait and try again.'
        : 'Not saved — server error. Try again in a moment.');
    });
    // HTMX confirm → styled Alpine dialog (only for elements carrying hx-confirm).
    document.body.addEventListener('htmx:confirm', function (e) {
      if (!e.detail || !e.detail.question) return; // no hx-confirm → native flow
      e.preventDefault();
      var el = e.detail.elt;
      var label = (el && el.getAttribute('data-confirm-label')) || 'Confirm';
      if (window.Alpine && Alpine.store('ui')) {
        var invoker = e.detail.triggeringEvent?.submitter || (el?.matches('button') ? el : null);
        if (invoker) invoker.focus({ preventScroll: true });
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
