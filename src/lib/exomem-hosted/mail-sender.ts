/**
 * Cloud mail is sent as Evermatter, from its Brevo sender on the authenticated evermatter.ai
 * domain. Replies to that address forward to the founder's inbox.
 */
export const EXOMEM_SENDER = {
  senderName: "Evermatter",
  senderEmail: "hello@evermatter.ai",
} as const;
