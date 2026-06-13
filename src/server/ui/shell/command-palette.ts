import { html, raw } from "hono/html";
import { NAV_SECTIONS, SETTINGS_ITEM, navItemVisible } from "./nav";
import { icon } from "../components/icons";
import type { Area } from "@/lib/license/areas";
import { AREAS } from "@/lib/license/areas";

type Html = ReturnType<typeof html>;

interface PaletteItem {
  label: string;
  href: string;
  hint: string;
}

/** The command list: every real nav target the license entitles + a "Connect channel" action.
 *  Area-gated so the palette never offers to jump to a hidden wing's page. */
function paletteItems(products: Set<Area>): PaletteItem[] {
  const navItems: PaletteItem[] = NAV_SECTIONS.flatMap((sec) =>
    sec.items
      .filter((it) => !it.soon && it.href !== "#" && navItemVisible(it, products))
      .map((it) => ({ label: it.label, href: it.href, hint: `Go · ${sec.section}` })),
  );
  return [
    { label: "Connect channel", href: "/channels", hint: "Action" },
    { label: SETTINGS_ITEM.label, href: SETTINGS_ITEM.href, hint: "Go" },
    ...navItems,
  ];
}

/**
 * The ⌘K / Ctrl-K command palette. Alpine-driven overlay: focus-trapped (x-pstrap), Esc to close,
 * type-to-filter, arrow/Enter to navigate. Also openable from the topbar search affordance
 * (which dispatches `ps:palette`). Keyboard-first; pure enhancement (hidden + inert without JS).
 */
export function commandPalette(products: Set<Area> = new Set<Area>(AREAS)): Html {
  // Items are a static, server-trusted list. Embed as JSON in a <script> the factory reads —
  // avoids fragile escaping inside an x-data attribute. The "</" guard keeps the JSON from
  // prematurely closing the script tag (defence-in-depth; the list contains no user/DB input).
  const itemsJson = JSON.stringify(paletteItems(products)).replace(/</g, "\\u003c");
  return html`<script id="ps-palette-data" type="application/json">${raw(itemsJson)}</script>
  <div
    class="cmdk"
    x-data="psPalette()"
    x-show="open"
    x-cloak
    @ps:palette.window="toggle()"
    @keydown.escape="close()"
    @click.self="close()"
    x-transition.opacity.duration.120ms
    role="dialog"
    aria-modal="true"
    aria-label="Command palette"
  >
    <div class="cmdk-panel" x-pstrap="open">
      <div class="cmdk-search">
        ${icon("search", "ico", 16)}
        <input
          type="text"
          x-model="query"
          x-ref="cmdkInput"
          @input="active = 0"
          @keydown.down.prevent="move(1)"
          @keydown.up.prevent="move(-1)"
          @keydown.enter.prevent="go()"
          placeholder="Jump to… (type to filter)"
          aria-label="Search commands"
          autocomplete="off"
          spellcheck="false"
        />
        <kbd class="cmdk-kbd">Esc</kbd>
      </div>
      <ul class="cmdk-list" role="listbox" aria-label="Commands">
        <template x-for="(it, i) in filtered" :key="it.href + it.label">
          <li
            class="cmdk-item"
            :class="{ 'is-active': i === active }"
            role="option"
            :aria-selected="i === active"
            @click="goTo(it.href)"
            @mousemove="active = i"
          >
            <span class="cmdk-label" x-text="it.label"></span>
            <span class="cmdk-hint" x-text="it.hint"></span>
          </li>
        </template>
        <li class="cmdk-empty" x-show="filtered.length === 0">No matches.</li>
      </ul>
    </div>
  </div>`;
}

/** The topbar affordance that opens the palette (also reachable via ⌘K). */
export function paletteTrigger(): Html {
  return html`<button
    type="button"
    class="cmdk-trigger"
    @click="$dispatch('ps:palette')"
    aria-label="Open command palette"
  >
    ${icon("search", "ico", 14)}
    <span class="cmdk-trigger-label">Jump to…</span>
    <kbd class="cmdk-kbd">⌘K</kbd>
  </button>`;
}

/** The Alpine component factory for the palette + the global ⌘K opener. Registered once. */
export function paletteScript(): Html {
  return html`${raw(`<script>
// Global ⌘K / Ctrl-K → dispatch ps:palette (same event the topbar trigger fires). Plain JS so it
// works independent of which Alpine component is in scope; ignored when typing in a field.
document.addEventListener('keydown', function (e) {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent('ps:palette'));
  }
});

document.addEventListener('alpine:init', function () {
  Alpine.data('psPalette', function () {
    var all = [];
    try {
      var el = document.getElementById('ps-palette-data');
      if (el) all = JSON.parse(el.textContent);
    } catch (e) { all = []; }
    return {
      open: false,
      query: '',
      active: 0,
      items: all,
      get filtered() {
        var q = this.query.trim().toLowerCase();
        if (!q) return this.items;
        return this.items.filter(function (it) {
          return (it.label + ' ' + it.hint).toLowerCase().indexOf(q) !== -1;
        });
      },
      toggle: function () { this.open ? this.close() : this.openPalette(); },
      openPalette: function () {
        this.open = true;
        this.query = '';
        this.active = 0;
        var self = this;
        this.$nextTick(function () { if (self.$refs.cmdkInput) self.$refs.cmdkInput.focus(); });
      },
      close: function () { this.open = false; },
      move: function (delta) {
        var n = this.filtered.length;
        if (!n) return;
        this.active = (this.active + delta + n) % n;
      },
      go: function () {
        var it = this.filtered[this.active];
        if (it) this.goTo(it.href);
      },
      goTo: function (href) { this.close(); window.location.href = href; },
    };
  });
});
</script>`)}`;
}
