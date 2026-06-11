import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { outboundDeliveries, webhookEvents } from "@/db/schema";

/**
 * Confirm an outbound delivery from a Meta echo. When Meta echoes one of OUR sent messages back
 * (message.is_echo), match the echoed mid against `outbound_deliveries.platform_message_id` and
 * stamp `confirmed_by_echo_at` — a second, platform-confirmed signal the reply actually left Meta,
 * beyond our own status=sent. Links the echo's webhook_events row back to the delivery and marks it
 * `ignored` (an echo is not actionable). A non-matching echo (e.g. a message sent by another tool
 * on the same page) is just marked `ignored`, touching no delivery.
 *
 * Best-effort: the echo is already logged; a confirmation failure must not fail the webhook.
 */
export async function confirmEcho(
  eventKey: string,
  echoedMid: string,
  channelId: string | null,
): Promise<void> {
  // Match the delivery by the echoed mid. Scope to the channel when known, so an id collision
  // across channels can't confirm the wrong row. Only an as-yet-unconfirmed delivery is stamped:
  // a redelivered echo (afterLog runs on every delivery) must not overwrite the first confirmation
  // timestamp with a later one.
  const match = channelId
    ? and(eq(outboundDeliveries.platform_message_id, echoedMid), eq(outboundDeliveries.channel_id, channelId))
    : eq(outboundDeliveries.platform_message_id, echoedMid);
  const where = and(match, isNull(outboundDeliveries.confirmed_by_echo_at));

  const [delivery] = await db
    .update(outboundDeliveries)
    .set({ confirmed_by_echo_at: new Date() })
    .where(where)
    .returning({ id: outboundDeliveries.id });

  await db
    .update(webhookEvents)
    .set({
      handling_status: "ignored",
      handled_at: new Date(),
      outbound_delivery_id: delivery?.id ?? null,
    })
    .where(and(eq(webhookEvents.event_key, eventKey), eq(webhookEvents.handling_status, "received")));
}
