// The custom-instructions block a hosted user pastes into their assistant.
//
// This is not a nice-to-have fallback. Exomem has no marketplace plugin yet, so
// nothing ships skills to the client — a bare MCP connection gives the assistant
// a set of tools and no reason to reach for them. This block is the entire
// behavioural layer, and pasting it is the difference between a connector that
// is merely attached and a knowledge base that actually gets used.
//
// It also carries the prominence level. `src/exomem/prominence.py` defines four
// levels and defaults hookless surfaces (web, hosted, chatgpt, claude-ai) to
// `maximal`, because there are no hooks there to re-arm the check each turn and
// passive instructions decay over a long conversation. The engine has no hosted
// command for changing it — `exomem prominence <level>` is CLI-only, and a
// hosted user has neither a shell nor a filesystem — so the mechanism the skill
// documents for these surfaces is exactly this: edit the level block in your
// assistant's custom instructions. Until a `set_prominence` command exists,
// generating that block here IS the setting.
//
// DRIFT WARNING: the level text below is transcribed from
// `exomem/src/exomem/prominence.py` (`CONTRACTS`). Different repo, different
// language, so it cannot be imported. If that file's wording changes, change it
// here too. `assistant-instructions.test.ts` pins the level set so at least a
// added or removed level cannot pass silently.

export type PromLevel = "off" | "light" | "balanced" | "maximal";

export const PROM_LEVELS: readonly PromLevel[] = ["off", "light", "balanced", "maximal"];

/** The level a hosted user gets unless they choose otherwise. Mirrors `WEB_DEFAULT_PROMINENCE`. */
export const DEFAULT_PROM_LEVEL: PromLevel = "maximal";

type LevelContract = {
  /** Short label for the picker. */
  label: string;
  /** One line the user reads while choosing. */
  summary: string;
  recall: string;
  capture: string;
  narration: string;
};

export const PROM_CONTRACTS: Record<PromLevel, LevelContract> = {
  off: {
    label: "Off",
    summary: "Only when I ask, explicitly.",
    recall: "Never search memory unless the user explicitly asks you to.",
    capture: "Never write to memory unless the user explicitly asks you to.",
    narration: "Say nothing about memory unless asked.",
  },
  light: {
    label: "Light",
    summary: "Recall when asked or clearly on-topic. Never writes on its own.",
    recall:
      "Search memory only when the user asks a recall question outright, or when the turn is unmistakably about a topic the knowledge base covers. When in doubt, do not search.",
    capture:
      "Write to memory only when the user asks. Do not capture on your own judgment, however durable the conclusion looks.",
    narration:
      "Never narrate memory activity. Fold retrieved facts into the answer with a citation and nothing more.",
  },
  balanced: {
    label: "Balanced",
    summary: "Recall on topic match, capture durable conclusions, stay quiet.",
    recall:
      "Search memory first when a turn references a project, a domain, a named entity, or asks what was concluded, tried, or decided. Skip it for chit-chat, control messages, and fresh tasks with no prior context.",
    capture:
      "Capture when the conversation reaches a stepping stone: a durable conclusion lands, or a recurring entity accumulates reusable facts. Not mid-thought exploration, tangents, or unresolved questions.",
    narration:
      "Stay quiet. Mention memory only when a search returned something you used, and report one line after a write.",
  },
  maximal: {
    label: "Maximal",
    summary: "Recall before every substantive turn, capture freely, and say so.",
    recall:
      "Search memory before answering any substantive turn, not only the ones that obviously reference prior work. Assume the knowledge base may hold something relevant until a search says otherwise. Only skip for pure chit-chat and control messages.",
    capture:
      "Capture at every stepping stone, and treat the bar for 'durable' as low: a decision, a resolved problem, a diagnosed failure, a reusable pattern, a fact about a recurring entity. When torn between capturing and letting it pass, capture. Prefer a real page over a mental note.",
    narration:
      "Say what you did. Name what you recalled and cite it; state one line after every write. The user should be able to see memory working without asking.",
  },
};

/**
 * The block to paste. Identical for every client — only where it goes differs.
 *
 * The closing two lines are not level-dependent and never omitted: the first is
 * the boundary that keeps secrets and throwaway chat out of a durable store, and
 * the second resolves the conflict every assistant has between its own memory
 * feature and this one.
 */
export function assistantInstructions(level: PromLevel): string {
  const contract = PROM_CONTRACTS[level];
  return [
    "Use Exomem as my long-term governed knowledge store, through its MCP tools.",
    "",
    `RECALL: ${contract.recall}`,
    "",
    `CAPTURE: ${contract.capture}`,
    "",
    `NARRATION: ${contract.narration}`,
    "",
    "Never capture transient chat, credentials, or anything I say not to save.",
    "Treat your own built-in memory as short-term working context; Exomem is the durable store.",
  ].join("\n");
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
  /** True when a marketplace one-click install could exist for this client. */
  installable: boolean;
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
 *
 * A one-click install replaces the `connect` half for a client when one exists;
 * it never removes the paste half, since no marketplace listing carries the
 * instructions block today.
 */
export const CLIENT_GUIDES: readonly ClientGuide[] = [
  {
    client: "claude",
    name: "Claude",
    connect:
      "Settings → Connectors → Add custom connector, paste the server address, then sign in when Claude prompts you.",
    pasteTarget: "Settings → Profile → personal preferences",
    installable: true,
  },
  {
    client: "chatgpt",
    name: "ChatGPT",
    connect:
      "Settings → Connectors → add a custom connector with the server address, then sign in when prompted.",
    pasteTarget: "Settings → Personalization → Custom instructions",
    installable: true,
  },
  {
    client: "claude-code",
    name: "Claude Code",
    connect: "One command, then authenticate in the browser it opens.",
    commands: (serverUrl) =>
      `claude mcp add --transport http exomem ${serverUrl}\n/mcp   # then choose exomem and authenticate`,
    pasteTarget: "CLAUDE.md, in your home directory or the project you want it in",
    installable: false,
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
    installable: false,
  },
  {
    client: "other",
    name: "Any other MCP client",
    connect:
      "Add the server address as a remote (streamable HTTP) MCP server. It uses OAuth, so expect a browser sign-in once.",
    pasteTarget: "wherever that client keeps system prompts or custom instructions",
    installable: false,
  },
];
