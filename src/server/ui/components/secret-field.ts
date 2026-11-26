import { raw } from "hono/html";

/**
 * Attributes for a password input holding a service credential (bot token, API key, client secret).
 * Browsers ignore `autocomplete="off"` there and offer to store the value as the user's password.
 */
export const SERVICE_SECRET_ATTRS = raw('autocomplete="new-password" data-1p-ignore data-lpignore="true"');
