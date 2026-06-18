import type { StoryRenderer } from "./renderer";
import { SharpStoryRenderer } from "./renderer";

let cached: StoryRenderer | null = null;

/** The process-wide Story renderer (lazy — `sharp` only loads when a card is actually rendered). */
export function getStoryRenderer(): StoryRenderer {
  if (!cached) cached = new SharpStoryRenderer();
  return cached;
}

/** Test seam: inject a fake renderer so the worker/hook tests never touch the native binding. */
export function __setStoryRenderer(r: StoryRenderer | null): void {
  cached = r;
}

export type { StoryRenderer, StoryCard, StoryStyle, StoryTemplate, StoryPlan } from "./renderer";
export { STORY_WIDTH, STORY_HEIGHT, STORY_TEMPLATES, DEFAULT_STORY_TEMPLATE, registerStoryTemplate, resolveStoryTemplate } from "./renderer";
