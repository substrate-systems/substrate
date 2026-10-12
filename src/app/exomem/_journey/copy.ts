// The words on every journey step, verbatim from the Journey board (copy() in
// docs/exomem-design/reference/boards/Journey-Page.dc.html, Appendix A of the
// handoff README). Names, dates and time limits arrive as arguments: the caller
// computes them at render from data, and nothing here holds a value.

/** The board's retry label, on "That didn’t finish" and wherever a step can be tried again. */
export const TRY_AGAIN = "Try again";

/** The Journey board's own name for an app it cannot name ("other" in its APPS). */
export const UNNAMED_APP = "your app";

export const startCopy = {
  web: {
    title: "Start with your email",
    lede: "New or returning, it’s the same step. No password.",
    primary: "Email me a link",
  },
  app: (app: string) => ({
    title: `Connect ${app} to your memory`,
    lede: "Sign in with your email. You’ll come straight back here.",
    primary: "Email me a sign-in link",
  }),
  emailLabel: "Email",
  reviewerLink: "App reviewer? Sign in here",
  switched: (email: string) => `Signed out of ${email}. Enter the email you want to use.`,
};

export const sentCopy = {
  title: "Check your email",
  /**
   * The board says "We sent you a link." Every request gets this page, including one
   * that queues no email (closed admission, a rate limit, an address that does not
   * normalize) and a repeat waitlist request. So the page claims neither a link nor an
   * email, and the button names what the person does: ask again (deviation (j)).
   */
  lede: "If this address can get an email from us, it’s on its way. You can close this tab.",
  sentTo: "To",
  openHere: "Open it on this device.",
  resend: TRY_AGAIN,
  resendIn: (clock: string) => `${TRY_AGAIN} in ${clock}`,
  differentEmail: "Use a different email",
};

export const reviewerCopy = {
  title: "Sign in as a reviewer",
  lede: "For app directory reviewers. Use the username and password from our submission notes.",
  note: "It’s a sample account with example notes, already subscribed, so there is no checkout.",
  username: "Reviewer username",
  password: "Reviewer password",
  primary: "Sign in as reviewer",
  back: "Back to email sign-in",
  failedOnWeb: "That didn’t work. Check the username and password.",
  failedInApp: (app: string, requestLife: string) =>
    `That didn’t work. Check the username and password. If this page is older than ${requestLife}, start again from ${app}.`,
};

export const inviteCopy = {
  /**
   * An invitation with no inviter (the operator's). The board draws only a friend's
   * ("Alex invited you to Exomem"); this is the subject of email 02, listed as a deviation.
   */
  standardTitle: "You’re invited to Exomem",
  lede: "A knowledge base that every assistant you use shares. It keeps where each thing came from, and what changed.",
  accept: "Accept invitation",
  accepting: {
    title: "Setting up your Exomem",
    lede: "A few seconds. Then add it to your assistant.",
  },
  unusable: {
    title: "This invitation can’t be used",
    lede: "It has expired, or it was already used. Ask the person who invited you for a new one, or start with your email.",
    primary: "Start with your email",
  },
};

export const signedInCopy = {
  prefix: (email: string) => `Signed in as ${email} · `,
  switchAccount: "Switch account",
};

export const subscribeCopy = {
  title: "Subscribe to finish setting up",
  /**
   * An account that holds a friend offer. Its price is not previewed here: the discount
   * stays on the server, and the usual price would be wrong for this person.
   */
  friendLede: (by: string, app: string | null) =>
    `${by}’s friend price is applied at checkout. Cancel any time through Paddle. ${app === null ? "Then add it to your assistant." : `Then ${app} connects in one step.`}`,
  primary: "Subscribe",
  notNow: "Not now",
  confirming: {
    title: "Confirming your payment",
    lede: (app: string | null) =>
      `A few seconds. ${app === null ? "Then add it to your assistant." : `Then ${app} connects in one step.`}`,
  },
};

/** The two assistants with a plugin, in the order the choose step lists them. */
export type PluginApp = "claude" | "openai";

export const chooseCopy = {
  title: "Add Exomem to your assistant",
  lede: "Your Exomem is ready. Pick where you’ll use it first; you can add more any time.",
  rows: {
    claude: { also: "also Claude Code, Desktop and Cowork", glyph: "C" },
    openai: { also: "also Codex", glyph: "G" },
  } satisfies Record<PluginApp, { also: string; glyph: string }>,
  open: (app: string) => `Open ${app} ↗`,
  connected: "connected ✓",
  other: {
    name: "Another app",
    also: "any app that supports MCP",
    glyph: "+",
    cta: "Show address",
  },
};

export const waitingCopy = {
  title: (app: string) => `Finish in ${app}`,
  where: {
    claude: "In Claude, open Settings, then Connectors. Find Exomem and press Connect.",
    openai: "In ChatGPT, open the plugin directory. Find Exomem and press Connect.",
  } satisfies Record<PluginApp, string>,
  then: (app: string) => `${app} then opens a page here to confirm.`,
  pickAnother: "Pick another app",
  waitingFor: (app: string) => `Waiting for ${app}…`,
};

export const otherAppCopy = {
  title: "Add Exomem to your app",
  lede: "Paste this address into the app’s connector or MCP settings. The app then opens a page here to confirm.",
  addressLabel: "Exomem address",
};

export const joinedCopy = {
  title: (app: string) => `${app} is connected.`,
  lede: "Try it: ask it to remember something today, then ask again tomorrow.",
  /**
   * The board adds "; we save your choice." The choice is not saved until the joined
   * step saves the level (Cloud Home levels), so the page does not say it is.
   */
  ledeWithoutPlugin: "Without the plugin, your app needs instructions. Pick how much it joins in.",
  done: (app: string) => `${app} · memory on`,
  home: "Go to Home",
  addToo: (app: string) => `Add ${app} too`,
  another: "Connect another app",
  levelsLabel: "How much your app uses Exomem",
  instructions: (level: string) => `${level} instructions`,
  characters: (count: string) => `${count} characters`,
  paste: "Paste it into the app’s instructions, or its rules file (AGENTS.md).",
  copy: "Copy",
  copied: "Copied",
};

export const consentCopy = {
  title: (app: string) => `Connect ${app} to your memory`,
  lede: "Everything you’ve kept, available in every session.",
  connect: "Connect",
  connecting: "Connecting…",
  notNow: "Not now",
  scopes: {
    recall: "Recall what you’ve kept",
    save: "Save new things, with their source",
    why: "Show why it believes something",
    paused: "paused",
    footnote: "Nothing is deleted or overwritten without you.",
  },
  again: {
    title: (app: string) => `${app} is already connected`,
    lede: "Connect again only if it stopped working. Its old access is replaced.",
    primary: "Connect again",
    keep: "Keep it as it is",
  },
  preparing:
    "Your Exomem is still starting. Connect now: its tools start working within a few minutes, and we’ll email you when it’s ready.",
  readOnly: {
    lede: "You can still connect. It recalls but doesn’t save until billing is fixed.",
    notice: (until: string) =>
      `Your last payment failed. Exomem is read-only while Paddle retries, until ${until}; after that the subscription ends.`,
    fixBilling: "Fix billing",
  },
  footer: (from: string) => `exomem · request from ${from}`,
  onThisComputer: (app: string) => `${app} on this computer`,
};

export const handbackCopy = {
  title: "Connected.",
  web: {
    lede: (app: string) => `Taking you back to ${app}…`,
    done: (app: string) => `If nothing happens, return to ${app}. It’s connected.`,
  },
  loopback: {
    lede: (app: string) => `Back to your terminal: ${app} finishes there.`,
    done: (app: string) => `${app} · memory on`,
  },
  declined: {
    title: (app: string) => `${app} isn’t connected`,
    lede: (app: string) =>
      `Nothing was shared. We told ${app} you said no. You can close this tab.`,
    ledeLoopback: (app: string) =>
      `Nothing was shared. Back in your terminal, ${app} stops waiting.`,
    connectAfterAll: "Connect after all",
  },
  kept: {
    title: "Nothing changed",
    lede: (app: string) => `${app} keeps the connection it has. You can close this tab.`,
    done: (app: string) => `${app} · still connected`,
  },
};

export const breakCopy = {
  /**
   * Connect's answer never reached the page: the server may have connected the app, so
   * the page claims no rollback. Not drawn by the board (design.md deviation (m)).
   */
  unconfirmed: {
    title: (app: string) => `We couldn’t confirm whether ${app} connected`,
    lede: (app: string) => `Start again from ${app}.`,
  },
  connectError: {
    title: "That didn’t finish",
    lede: (app: string) =>
      `Exomem had a problem on our side while connecting ${app}. Nothing changed. Try again in a minute.`,
    notice: "If it keeps happening, our status page says what we know.",
    retry: TRY_AGAIN,
    statusPage: "Status page ↗",
  },
  ended: {
    title: "Your subscription has ended",
    lede: (until: string, app: string) =>
      `Your memory is read-only and kept until ${until}. Export it any time before then, or resubscribe to connect ${app}.`,
    /** Added to the lede when the account holds a friend offer, which checkout applies again. */
    friendBack: (by: string) => ` ${by}’s friend price comes back if you do.`,
    resubscribe: "Resubscribe",
  },
  paused: {
    title: "Your subscription is paused",
    lede: (app: string) => `Your memory is kept and readable. Resume it to connect ${app}.`,
    resume: "Resume subscription",
  },
  suspended: {
    title: "This Exomem is suspended",
    lede: (app: string) =>
      `It can’t connect to ${app} while it’s suspended. Your memory is safe, and you can still export it.`,
    notice: (reference: string) =>
      `Write to support and quote ${reference}. We’ll tell you why it was suspended and what happens next.`,
    contact: "Contact support",
  },
  expired: {
    title: "This request has expired",
    lede: (requestLife: string, app: string) =>
      `Connection requests last ${requestLife}. Start again from ${app}, and it will bring you back here.`,
  },
  export: "Export your memory",
  /** A web start names no app: the break steps say "your assistant". */
  webApp: "your assistant",
};

/**
 * The authorization endpoint's answer to an app it does not know or no longer admits.
 * Not drawn by the board (design.md deviation (n)).
 */
export const unknownAppCopy = {
  title: "Exomem doesn’t recognise this app",
  lede: "Remove Exomem from the app, then add it again. The app then opens a page here to confirm.",
};

/**
 * Failures the boards do not draw. Each follows the board's own wording ("That
 * didn’t work.", "Try again in a minute.") and is listed for the owner's approval.
 */
export const failureCopy = {
  challenge: "That didn’t work. Try again.",
  generic: "That didn’t work. Try again in a minute.",
  /** Unchanged from the page this journey replaces. */
  linkUnusable: "That link has expired or was already used. Enter your email below for a new one.",
  /** Unchanged from the page this journey replaces. */
  invitationNotReady: "Your invitation is fine — Exomem itself is not ready to open it yet.",
};

/**
 * Beside where a request's answer goes, for an app whose name Exomem does not vouch
 * for (deviation (i) in the change's design: the label is not yet approved copy).
 */
export const claimCopy = (name: string) => `“${name}” is the name it gives itself`;

/** A date the account does not know yet (Known with a reason), in a sentence that needs one. */
export const unknownDate = "a date not known yet";
