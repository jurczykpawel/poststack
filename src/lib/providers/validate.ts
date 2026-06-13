import type { Provider, PublishRequest } from "./types";

export type ValidateResult = { ok: true } | { ok: false; errors: string[] };

export function validate(provider: Provider, request: PublishRequest): ValidateResult {
  const cap = provider.capabilities().find((c) => c.format === request.format);
  if (!cap) {
    return { ok: false, errors: [`unsupported format '${request.format}' for ${provider.id}`] };
  }
  const errors: string[] = [];
  const n = request.media.length;
  if (n < cap.media.min) errors.push(`format '${request.format}' needs >= ${cap.media.min} media`);
  if (n > cap.media.max) errors.push(`format '${request.format}' allows <= ${cap.media.max} media`);
  if (cap.caption?.required && !request.caption) errors.push("caption is required");
  if (cap.caption && request.caption && request.caption.length > cap.caption.maxLength) {
    errors.push(`caption exceeds ${cap.caption.maxLength} chars`);
  }
  if (cap.title?.required && !request.title) errors.push("title is required");
  for (const opt of cap.requiredOptions ?? []) {
    if (request.options?.[opt] === undefined) errors.push(`missing required option '${opt}'`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
