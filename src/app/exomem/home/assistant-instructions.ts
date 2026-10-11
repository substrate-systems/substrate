// The custom-instructions block a hosted user pastes into their assistant.
//
// This is not a nice-to-have fallback. Exomem has no marketplace plugin yet, so
// nothing ships skills to the client — a bare MCP connection gives the assistant
// a set of tools and no reason to reach for them. This block is the entire
// behavioural layer, and pasting it is the difference between a connector that
// is merely attached and a knowledge base that actually gets used.
//
// It also carries the prominence level. Hookless surfaces (web, hosted, chatgpt,
// claude-ai) default to `maximal`, because there are no hooks there to re-arm the
// check each turn and passive instructions decay over a long conversation. The
// `configure_memory` command changes the saved level; the Cloud cell profile
// exposes it.
//
// The block text is not written here. `instruction-blocks.generated.ts` holds a
// verbatim copy of the Exomem repo's `docs/prominence.md` at the commit it names.
// Run `npm run sync:instruction-blocks -- <exomem-repo>` when the doc changes; a
// weekly workflow fails when the doc has moved on. Never trim a block by hand: a
// shortened capture list silently drops classes of capture.

import { INSTRUCTION_BLOCKS } from "./instruction-blocks.generated";

export type PromLevel = "off" | "light" | "balanced" | "maximal";

export const PROM_LEVELS: readonly PromLevel[] = ["off", "light", "balanced", "maximal"];

/** The level a hosted user gets unless they choose otherwise. Mirrors `WEB_DEFAULT_PROMINENCE`. */
export const DEFAULT_PROM_LEVEL: PromLevel = "maximal";

type LevelContract = {
  /** Short label for the picker. */
  label: string;
  /** One line the user reads while choosing. */
  summary: string;
};

export const PROM_CONTRACTS: Record<PromLevel, LevelContract> = {
  off: {
    label: "Off",
    summary: "Only when I ask, explicitly.",
  },
  light: {
    label: "Light",
    summary: "Recall when asked or clearly on-topic. Never writes on its own.",
  },
  balanced: {
    label: "Balanced",
    summary: "Recall on topic match, capture durable conclusions, stay quiet.",
  },
  maximal: {
    label: "Maximal",
    summary: "Recall before every substantive turn, capture freely, and say so.",
  },
};

/** The block to paste, exactly as the copied `docs/prominence.md` has it. Identical for every client. */
export function assistantInstructions(level: PromLevel): string {
  return INSTRUCTION_BLOCKS[level];
}

export type ConnectClient = "claude" | "chatgpt" | "claude-code" | "codex" | "other";

export type ClientGuide = {
  client: ConnectClient;
  name: string;
  /** How the MCP server gets attached. */
  connect: string;
  /** Terminal commands, when that is how connecting works. */
  commands?: (serverUrl: string) => string;
  /** Where this client keeps the instructions the block goes into. */
  pasteTarget: string;
  /**
   * Set when this client cannot connect at all yet, with the reason.
   *
   * A client listed with steps that cannot work is worse than one listed as
   * unsupported: the person follows them, fails, and has no way to tell whether
   * they made a mistake. So the blocker is stated instead of the steps.
   */
  blocked?: string;
};

/**
 * Every client, always — each naming its own paste target, because that is the
 * step people get wrong and it differs per client.
 */
export const CLIENT_GUIDES: readonly ClientGuide[] = [
  {
    client: "claude",
    name: "Claude",
    connect:
      "Settings → Connectors → Add custom connector, paste the server address, then sign in when Claude prompts you.",
    pasteTarget: "Settings → Profile → personal preferences",
  },
  {
    client: "chatgpt",
    name: "ChatGPT",
    connect:
      "Settings → Connectors → add a custom connector with the server address, then sign in when prompted.",
    pasteTarget: "Settings → Personalization → Custom instructions",
  },
  {
    client: "claude-code",
    name: "Claude Code",
    connect: "One command, then authenticate in the browser it opens.",
    commands: (serverUrl) =>
      `claude mcp add --transport http exomem ${serverUrl}\n/mcp   # then choose exomem and authenticate`,
    pasteTarget: "CLAUDE.md, in your home directory or the project you want it in",
  },
  {
    client: "codex",
    name: "Codex CLI",
    // `codex mcp add` succeeds and `codex mcp login` then fails: Codex registers
    // itself through RFC 7591 Dynamic Client Registration, and Exomem has no
    // registration endpoint, so there is no identity for it to authorize as.
    // This shipped as two commands and a browser sign-in that never arrives.
    connect: "Not connectable yet.",
    // Deliberately does not recommend a specific alternative. Claude Code is the
    // obvious candidate and is listed directly above, but whether it authorizes
    // without a registration endpoint has not been observed here, and naming it
    // as the workaround would repeat, one row down, the exact mistake this entry
    // exists to correct.
    blocked:
      "Codex CLI signs in by registering itself dynamically (RFC 7591), which Exomem does not " +
      "support yet, so there is nothing for it to authenticate as. Adding it needs a " +
      "registration endpoint on the Exomem side.",
    pasteTarget: "AGENTS.md, once Codex can connect",
  },
  {
    client: "other",
    name: "Any other MCP client",
    connect:
      "Add the server address as a remote (streamable HTTP) MCP server. It uses OAuth, so expect a browser sign-in once.",
    pasteTarget: "wherever that client keeps system prompts or custom instructions",
  },
];
