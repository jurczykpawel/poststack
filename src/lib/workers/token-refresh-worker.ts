import type { Job } from "bullmq";
import type { TokenRefreshJob } from "@/lib/queue/types";

// Implemented in Phase 8 (settings + token lifecycle)
export async function processTokenRefresh(
  _job: Job<TokenRefreshJob>
): Promise<void> {
  throw new Error("token-refresh-worker not yet implemented");
}
