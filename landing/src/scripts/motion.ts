/**
 * Progressive-enhancement motion layer.
 * - Scroll reveals via IntersectionObserver (works without GSAP).
 * - Sticky-nav elevation on scroll.
 * - GSAP is lazy-loaded only for the hero parallax + number counters.
 * Everything is a no-op under prefers-reduced-motion (CSS already shows content).
 */
import { ruleTester } from "../content/landing";

export function initMotion(): void {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  initNav();
  initRuleTester(reduce);

  if (reduce) {
    // Leave content visible (no .reveal-ready), run no animation.
    return;
  }

  // Inline head script already added `.reveal-ready` (no-flash). Mark as handled
  // so the inline safety timer becomes a no-op.
  document.documentElement.classList.add("reveal-ready");
  document.documentElement.dataset.revealed = "1";
  initReveals();
  initInviewPlay();
  void initGsap();
}

/** Toggle `.is-playing` on [data-inview-play] elements so looping CSS animations
 *  only run while on screen (saves CPU, keeps them in sync on re-entry). */
function initInviewPlay(): void {
  const els = Array.from(document.querySelectorAll<HTMLElement>("[data-inview-play]"));
  if (els.length === 0 || !("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("is-playing"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) e.target.classList.toggle("is-playing", e.isIntersecting);
    },
    { threshold: 0.3 },
  );
  els.forEach((el) => io.observe(el));
}

function initNav(): void {
  const nav = document.querySelector<HTMLElement>("[data-nav]");
  if (!nav) return;
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 24);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

function initReveals(): void {
  const items = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
  if (!("IntersectionObserver" in window) || items.length === 0) {
    items.forEach((el) => el.classList.add("is-in"));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        // Stagger siblings sharing a [data-reveal-group] parent.
        const group = el.closest("[data-reveal-group]");
        if (group) {
          const siblings = Array.from(group.querySelectorAll<HTMLElement>("[data-reveal]"));
          siblings.indexOf(el) >= 0 &&
            el.style.setProperty("--reveal-delay", `${siblings.indexOf(el) * 70}ms`);
        }
        el.classList.add("is-in");
        io.unobserve(el);
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.12 },
  );

  items.forEach((el) => io.observe(el));
}

async function initGsap(): Promise<void> {
  const { gsap } = await import("gsap");
  const { ScrollTrigger } = await import("gsap/ScrollTrigger");
  gsap.registerPlugin(ScrollTrigger);

  // Lenis cinematic smooth-scroll, paired with GSAP (reference §10.2).
  const Lenis = (await import("lenis")).default;
  const lenis = new Lenis({ lerp: 0.1, syncTouch: true, touchMultiplier: 2 });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);

  initScrollStory(gsap, ScrollTrigger);

  const hero = document.querySelector<HTMLElement>("[data-hero-mock]");
  const counters = document.querySelectorAll<HTMLElement>("[data-count]");

  // Hero mock: gentle parallax + tilt settle as you scroll past.
  if (hero) {
    gsap.fromTo(
      hero,
      { y: 0, rotateX: 7 },
      {
        y: -36,
        rotateX: 0,
        ease: "none",
        scrollTrigger: { trigger: hero, start: "top 75%", end: "top 20%", scrub: 0.6 },
      },
    );
  }

  // (scroll story handled above) Animated counters when they enter view.
  counters.forEach((el) => {
    const target = parseFloat(el.dataset.count || "0");
    const suffix = el.dataset.suffix || "";
    const obj = { v: 0 };
    ScrollTrigger.create({
      trigger: el,
      start: "top 88%",
      once: true,
      onEnter: () =>
        gsap.to(obj, {
          v: target,
          duration: 1.4,
          ease: "power2.out",
          onUpdate: () => {
            el.textContent = Math.round(obj.v).toString() + suffix;
          },
        }),
    });
  });
}

/**
 * Interactive auto-reply playground. Clicking a keyword runs the matching rule:
 * incoming comment → "rule matched" → typing → auto-reply + buttons.
 * Autoplays through rules when in view (motion only); user click takes over.
 * Works under reduced-motion too (instant state, no autoplay).
 */
function initRuleTester(reduce: boolean): void {
  const triggers = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-rt-trigger]"));
  if (triggers.length === 0) return;

  const q = <T extends Element>(sel: string) => document.querySelector<T>(sel);
  const commentEl = q<HTMLElement>("[data-rt-comment]");
  const matchEl = q<HTMLElement>("[data-rt-match]");
  const typingEl = q<HTMLElement>("[data-rt-typing]");
  const replyWrap = q<HTMLElement>("[data-rt-replywrap]");
  const replyEl = q<HTMLElement>("[data-rt-reply]");
  const buttonsEl = q<HTMLElement>("[data-rt-buttons]");
  if (!commentEl || !matchEl || !typingEl || !replyWrap || !replyEl || !buttonsEl) return;
  // Capture narrowed (non-null) refs so the async closure keeps the types.
  const el = {
    comment: commentEl,
    match: matchEl,
    typing: typingEl,
    replyWrap,
    reply: replyEl,
    buttons: buttonsEl,
  };

  const rules = ruleTester.rules;
  let token = 0;
  let current = 0;
  let autoplay: ReturnType<typeof setInterval> | null = null;

  const setActive = (i: number) =>
    triggers.forEach((t, j) => t.setAttribute("aria-pressed", j === i ? "true" : "false"));

  const renderButtons = (labels: readonly string[]) => {
    el.buttons.replaceChildren();
    for (const label of labels) {
      const span = document.createElement("span");
      span.className =
        "rounded-lg border border-border-medium bg-base px-2.5 py-1 text-xs text-ink-2";
      span.textContent = label;
      el.buttons.appendChild(span);
    }
  };

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function play(i: number): Promise<void> {
    const mine = ++token;
    current = i;
    const rule = rules[i];
    setActive(i);
    el.comment.textContent = rule.comment;
    el.match.textContent = `matched · ${rule.keyword}`;

    if (reduce) {
      el.match.style.opacity = "1";
      el.typing.classList.add("hidden");
      renderButtons(rule.buttons);
      el.reply.textContent = rule.reply;
      el.replyWrap.style.opacity = "1";
      return;
    }

    // reset
    el.match.style.opacity = "0";
    el.replyWrap.style.opacity = "0";
    el.replyWrap.classList.remove("rt-reveal");
    el.typing.classList.remove("hidden");

    await wait(220);
    if (mine !== token) return;
    el.match.style.opacity = "1";

    await wait(720);
    if (mine !== token) return;
    el.typing.classList.add("hidden");
    renderButtons(rule.buttons);
    el.reply.textContent = rule.reply;
    el.replyWrap.style.opacity = "1";
    el.replyWrap.classList.add("rt-reveal");
  }

  const stopAutoplay = () => {
    if (autoplay) {
      clearInterval(autoplay);
      autoplay = null;
    }
  };

  triggers.forEach((t, i) =>
    t.addEventListener("click", () => {
      stopAutoplay();
      void play(i);
    }),
  );

  if (reduce) return; // no autoplay; first rule already rendered server-side

  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !autoplay) {
            autoplay = setInterval(() => void play((current + 1) % rules.length), 3600);
          } else if (!e.isIntersecting) {
            stopAutoplay();
          }
        }
      },
      { threshold: 0.4 },
    );
    io.observe(triggers[0].closest("section") as Element);
  }
}

type Gsap = (typeof import("gsap"))["gsap"];
type ScrollTriggerStatic = (typeof import("gsap/ScrollTrigger"))["ScrollTrigger"];

/**
 * Signature scroll-driven moment: pin "the PostStack loop" and scrub through
 * Capture → Convert → Nurture as the user scrolls. Desktop only; on mobile and
 * under reduced-motion the three scenes simply stack (no pin).
 */
function initScrollStory(gsap: Gsap, ScrollTrigger: ScrollTriggerStatic): void {
  const section = document.querySelector<HTMLElement>("[data-scrollstory]");
  if (!section) return;
  if (!window.matchMedia("(min-width: 1024px)").matches) return;

  const stagewrap = section.querySelector<HTMLElement>("[data-story-stagewrap]");
  const scenes = gsap.utils.toArray<HTMLElement>("[data-story-scene]", section);
  const caps = Array.from(section.querySelectorAll<HTMLElement>("[data-story-cap]"));
  const fill = section.querySelector<HTMLElement>("[data-story-fill]");
  if (!stagewrap || scenes.length < 3) return;

  section.classList.add("is-scrolly");

  const setActive = (i: number) =>
    caps.forEach((c, j) => (j === i ? c.setAttribute("data-active", "") : c.removeAttribute("data-active")));

  void ScrollTrigger; // plugin already registered by caller
  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: stagewrap,
      start: "center center",
      end: "+=180%",
      pin: true,
      scrub: 0.6,
      onUpdate: (self) => setActive(self.progress < 0.4 ? 0 : self.progress < 0.78 ? 1 : 2),
    },
  });

  tl.set(scenes[1], { opacity: 0 }).set(scenes[2], { opacity: 0 });
  if (fill) tl.fromTo(fill, { scaleY: 0 }, { scaleY: 1, ease: "none", duration: 1.4 }, 0);
  tl.to(scenes[0], { opacity: 0, duration: 0.4 }, 0.34)
    .to(scenes[1], { opacity: 1, duration: 0.4 }, 0.34)
    .to(scenes[1], { opacity: 0, duration: 0.4 }, 0.78)
    .to(scenes[2], { opacity: 1, duration: 0.4 }, 0.78);
}
