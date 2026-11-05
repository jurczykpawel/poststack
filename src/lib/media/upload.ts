import { getStorage } from "@/lib/storage";
import { ingestStream } from "./ingest-stream";
import { withIngestSlot } from "./ingest-limit";
import { defaultProbe } from "./probe";
import { casKey } from "./cas";
import { registerKnownMedia } from "./service";

export async function uploadMedia(request: Request, workspaceId: string) {
  const storage = getStorage();
  const type = request.headers.get("content-type")?.split(";")[0]?.trim();
  return withIngestSlot(() => ingestStream(new Response(request.body, { headers: request.headers }), storage, async ({ checksum, size, prefix, file, temporary }) => {
    const probe = await defaultProbe(prefix, type === "application/octet-stream" ? undefined : type, file);
    const mime = probe.mime!;
    await storage.copy(temporary, casKey(checksum, mime), mime, { sha256: checksum });
    return registerKnownMedia({ checksum, size, mime, kind: probe.kind, durationSec: probe.durationSec, width: probe.width, height: probe.height }, { storage }, workspaceId);
  }));
}
