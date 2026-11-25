/**
 * Cloud mail is sent as Evermatter, from its Brevo sender on the authenticated evermatter.ai
 * domain. Replies go to the Reply-To address that brevo.ts sets; mail sent to this address
 * forwards to the founder's inbox through the domain's Email Routing.
 */
export const EXOMEM_SENDER = {
  senderName: "Evermatter",
  senderEmail: "hello@evermatter.ai",
} as const;
