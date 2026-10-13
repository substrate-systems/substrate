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
   * that queues no email (a rate limit or an address that does not normalize) and a repeat waitlist request. So the page claims neither a link nor an
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
  friendTitle: (by: string) => `${by} invited you to Exomem`,
  lede: "A knowledge base that every assistant you use shares. It keeps where each thing came from, and what changed.",
  accept: "Accept invitation",
  price: {
    friend: (by: string) => `Friend price from ${by}`,
    covered: (by: string) => `Covered by ${by}`,
    /** The Exomem price is monthly; the invitation emails write it the same way. */
    perMonth: (amount: string) => `${amount} a month`,
    nothingToPay: "Nothing to pay",
    atCheckout: "Shown at checkout",
    whileSubscribed: "For as long as you stay subscribed.",
    whileCovered: "For as long as it’s covered. We’ll email you before that changes.",
    exactAtCheckout: "Paddle shows the exact amount before you pay.",
  },
  existing: {
    title: "You already have Exomem",
    lede: (by: string) =>
      `${by}’s invitation can’t start a second one, but ${by}’s friend price can go on the plan you have. It starts with your next payment.`,
    useFriendPrice: (by: string) => `Use ${by}’s friend price`,
    keep: "Keep my plan as it is",
    /**
     * Not drawn by the board (design.md deviation (o)): an invitation that offers the
     * plan nothing, and an owner who has not signed in yet.
     */
    noOffer: (by: string | null) =>
      `${by ? `${by}’s invitation` : "This invitation"} can’t start a second one, and it doesn’t change the plan you have.`,
    unchecked: (by: string) =>
      `${by}’s invitation can’t start a second one. We couldn’t check just now whether ${by}’s friend price fits the plan you have.`,
    otherPrice: (by: string) =>
      `${by}’s invitation can’t start a second one, and ${by}’s friend price doesn’t apply to the plan you have.`,
    signIn: (by: string | null) =>
      `Sign in to answer ${by ? `${by}’s invitation` : "this invitation"}, then open it again from the email.`,
    signInPrimary: "Sign in",
    /** The friend price may already be on the plan when the answer fails, so no "Nothing changed". */
    notFinished: "That didn’t finish. Try again in a minute.",
    notOffered: "The friend price doesn’t apply to the plan you have.",
  },
  applied: {
    title: "Friend price added",
    lede: (by: string) =>
      `${by}’s friend price starts with your next payment. Paddle sends the new amount on your receipt.`,
    done: "friend price · from your next payment",
  },
  /** Not drawn by the board (design.md deviation (o)): no live subscription to change yet. */
  appliedOnResubscribe: {
    title: "Friend price added",
    lede: (by: string) => `${by}’s friend price applies when you subscribe.`,
    done: "friend price · at checkout",
  },
  kept: {
    title: "Nothing changed",
    lede: "Your plan stays as it is. The invitation is used up, so nobody else can use it.",
  },
  home: "Go to Home",
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
  prefix: "Signed in as ",
  separator: " · ",
  switchAccount: "Switch account",
};

export const subscribeCopy = {
  title: "Subscribe to finish setting up",
  /**
   * An account that holds a friend offer. The usual price would be wrong for this person,
   * so the step shows the friend price card with the amount left to checkout.
   */
  friendLede: (by: string) =>
    `${by}’s friend price is applied at checkout. Cancel any time through Paddle. Then add it to your assistant.`,
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
  /** The board's lede, when the cell can take the level now. */
  ledeSaving:
    "Without the plugin, your app needs instructions. Pick how much it joins in; we save your choice.",
  /** Without the save promise while the level cannot be saved (design.md deviation (l)). */
  ledeWithoutPlugin: "Without the plugin, your app needs instructions. Pick how much it joins in.",
  /** A level belongs to every app of a kind, "chat apps" or "coding agents". */
  saved: (apps: string) => `Saved for all your ${apps}.`,
  /** Not drawn by the board (design.md deviation (l)). */
  notSaved: "Not saved yet: your Exomem can’t take it now.",
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
    notice: (until: string | null) =>
      until && until !== unknownDate
        ? `Your last payment failed. Exomem is read-only while Paddle retries, until ${until}; after that the subscription ends.`
        : "Your last payment failed. Exomem is read-only while Paddle retries. We don’t know when retries will end; the subscription ends after that.",
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
    /** The lede while Home offers no export (design.md deviation (s)). */
    ledeWithoutExport: (until: string, app: string) =>
      `Your memory is read-only and kept until ${until}. Resubscribe to connect ${app}.`,
    /** Added to the lede when the account holds a friend offer, which checkout applies again. */
    friendBack: (by: string) => ` ${by}’s friend price comes back if you do.`,
    /**
     * The lede while no checkout can start, so nothing offers resubscribing; Home's ended
     * banner says the same. Without a kept date it says only that the memory is read-only
     * (design.md (af)).
     */
    ledeWithoutCheckout: (until: string | null, exportOffered: boolean) =>
      until
        ? `Your memory is read-only and kept until ${until}.${exportOffered ? " Export it any time before then." : ""}`
        : "Your memory is read-only.",
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
    /** The lede while Home offers no export (design.md deviation (s)). */
    ledeWithoutExport: (app: string) =>
      `It can’t connect to ${app} while it’s suspended. Your memory is safe.`,
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
  /** The same button, to Home, while Home offers no export (design.md deviation (s)). */
  home: "Go to Home",
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
export const claimCopy = (name: string) => `App-supplied name: “${name}”`;

/** A date the account does not know yet (Known with a reason), in a sentence that needs one. */
export const unknownDate = "a date not known yet";
