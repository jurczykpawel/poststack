// PSA12: the declared Content-Type is attacker-controlled, so a media blob's real type must be
// determined from its leading magic bytes — never the header. Covers the formats the platform
// adapters accept (jpeg/png/gif/webp images; mp4/quicktime/webm video).

const ascii = (b: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...b.subarray(start, end));

/** Detect a media MIME from leading magic bytes; `undefined` when the content is unrecognized. */
export function sniffMime(bytes: Uint8Array): string | undefined {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  )
    return "image/png";
  if (b.length >= 6 && ascii(b, 0, 4) === "GIF8") return "image/gif";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12).toLowerCase();
    return brand.startsWith("qt") ? "video/quicktime" : "video/mp4"; // isom/mp42/M4V/etc.
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm"; // EBML
  return undefined;
}
