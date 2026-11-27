/**
 * The two addresses of the monthly digest's unsubscribe, with no imports so
 * the page (a client component) and the signing module read the same text:
 * the page that a link in the email opens, and the route that its button and a
 * mail client's one-click POST call.
 */
export const UNSUBSCRIBE_PAGE_PATH = "/exomem/unsubscribe/monthly-update";
export const UNSUBSCRIBE_POST_PATH = "/api/exomem/unsubscribe/monthly-update";
