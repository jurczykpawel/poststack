const EXT_BY_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function extForMime(mime: string | undefined): string {
  return (mime && EXT_BY_MIME[mime]) ?? "bin";
}

export function casKey(hash: string, mime: string | undefined): string {
  return `media/sha256/${hash}.${extForMime(mime)}`;
}
