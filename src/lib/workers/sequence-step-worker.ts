import type { Job } from "bullmq";
import type { SequenceStepJob } from "@/lib/queue/types";

// Implemented in Phase 6 (sequences)
export async function processSequenceStep(
  _job: Job<SequenceStepJob>
): Promise<void> {
  throw new Error("sequence-step-worker not yet implemented");
}
