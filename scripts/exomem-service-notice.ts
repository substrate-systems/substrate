/**
 * The operator's one command for Exomem Cloud service notices
 * (`add-exomem-service-notices`, D4). It calls the admin route, then mirrors the
 * notice to the public status repository with the operator's own `gh` login.
 * Substrate holds no GitHub credential, and a status issue names no tenant or cell.
 *
 *   EXOMEM_PUBLIC_BASE_URL and EXOMEM_ADMIN_TOKEN name the deployment and the operator.
 *
 *   npx tsx scripts/exomem-service-notice.ts list
 *   npx tsx scripts/exomem-service-notice.ts preview maintenance --summary "..." --starts 2026-12-01T02:00:00Z --ends 2026-12-01T02:30:00Z [--cell <id>]...
 *   npx tsx scripts/exomem-service-notice.ts create maintenance --summary "..." --starts ... --ends ... [--line <status-line-slug>]... [--yes]
 *   npx tsx scripts/exomem-service-notice.ts create incident --summary "..." --line <status-line-slug> [--yes]
 *   npx tsx scripts/exomem-service-notice.ts cancel <notice-id>
 *   npx tsx scripts/exomem-service-notice.ts resolve <notice-id> --account "what happened, in one line"
 *
 * `create` shows who the notice reaches and the sentence the assistant will relay,
 * then waits for "y". `--yes` answers it for a run that already showed the preview.
 * `--no-mirror` leaves the status page alone.
 */

import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { NoticeKind } from "../src/lib/exomem-hosted/service-notice-model";

// The status repository is a third party's (GitHub's) place, so it is configuration.
const DEFAULT_STATUS_REPO = "substrate-systems/exomem-status";
const REQUEST_TIMEOUT_MS = 20_000;

export type DescribedNotice = {
  id: string;
  kind: NoticeKind;
  summary: string;
  state: string;
  say: string | null;
  startsAt: string;
  endsAt: string | null;
  cellIds: string[];
};

export type StatusIssue = { title: string; body: string; labels: string[] };

/** The line that ties an issue back to its notice, so cancel and resolve can find it. */
export function noticeMarker(noticeId: string): string {
  return `<!-- exomem-notice: ${noticeId} -->`;
}

/**
 * The public issue for a notice. Maintenance carries Upptime's metadata block
 * first, because the status page reads the first `<!-- -->` of the body. An
 * incident carries the labels `status` and the slug of the affected line.
 * Only the operator's own summary and times go in: never a tenant or a cell.
 */
export function statusIssueFor(
  notice: Pick<DescribedNotice, "id" | "kind" | "summary" | "startsAt" | "endsAt">,
  lines: string[]
): StatusIssue {
  if (notice.kind === "incident") {
    return {
      title: notice.summary,
      body: noticeMarker(notice.id),
      labels: ["status", ...lines],
    };
  }
  const metadata = [
    `start: ${notice.startsAt}`,
    `end: ${notice.endsAt}`,
    ...(lines.length > 0 ? [`expectedDown: ${lines.join(", ")}`] : []),
  ];
  return {
    title: notice.summary,
    body: `<!--\n${metadata.join("\n")}\n-->\n\n${noticeMarker(notice.id)}`,
    labels: ["maintenance"],
  };
}

/** The open issue that mirrors a notice, or null when none carries its marker. */
export function issueNumberFor(
  issues: Array<{ number: number; body: string }>,
  noticeId: string
): number | null {
  return issues.find((issue) => issue.body.includes(noticeMarker(noticeId)))?.number ?? null;
}

// --- Talking to the deployment ---

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function admin<T>(method: "GET" | "POST", body?: Record<string, unknown>): Promise<T> {
  const base = requiredEnv("EXOMEM_PUBLIC_BASE_URL").replace(/\/+$/, "");
  const response = await fetch(`${base}/api/exomem/admin/service-notices`, {
    method,
    headers: {
      authorization: `Bearer ${requiredEnv("EXOMEM_ADMIN_TOKEN")}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    throw new Error(`${response.status}: ${payload?.error?.message ?? "the request failed"}`);
  }
  return payload as T;
}

// --- Talking to the status repository ---

function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: REQUEST_TIMEOUT_MS * 3 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout.trim());
    });
  });
}

const statusRepo = () => process.env.EXOMEM_STATUS_REPO?.trim() || DEFAULT_STATUS_REPO;

async function openIssue(issue: StatusIssue): Promise<string> {
  return gh([
    "issue",
    "create",
    "--repo",
    statusRepo(),
    "--title",
    issue.title,
    "--body",
    issue.body,
    ...issue.labels.flatMap((label) => ["--label", label]),
  ]);
}

async function closeIssueFor(
  notice: DescribedNotice,
  comment: string,
  reason: "completed" | "not planned"
): Promise<string> {
  const label = notice.kind === "maintenance" ? "maintenance" : "status";
  const listed = await gh([
    "issue",
    "list",
    "--repo",
    statusRepo(),
    "--state",
    "open",
    "--label",
    label,
    "--limit",
    "100",
    "--json",
    "number,body",
  ]);
  const number = issueNumberFor(JSON.parse(listed || "[]"), notice.id);
  if (number === null) throw new Error(`no open ${label} issue carries this notice's marker`);
  await gh([
    "issue",
    "close",
    String(number),
    "--repo",
    statusRepo(),
    "--comment",
    comment,
    "--reason",
    reason,
  ]);
  return `${statusRepo()}#${number}`;
}

// --- The command ---

const OPTIONS = {
  summary: { type: "string" },
  starts: { type: "string" },
  ends: { type: "string" },
  "announce-from": { type: "string" },
  cell: { type: "string", multiple: true },
  line: { type: "string", multiple: true },
  account: { type: "string" },
  yes: { type: "boolean" },
  "no-mirror": { type: "boolean" },
} as const;

const readCommandLine = () => parseArgs({ options: OPTIONS, allowPositionals: true });
type Values = ReturnType<typeof readCommandLine>["values"];

function noticeFields(kind: string, values: Values): Record<string, unknown> {
  return {
    kind,
    summary: values.summary,
    ...(values.starts ? { startsAt: values.starts } : {}),
    ...(values.ends ? { endsAt: values.ends } : {}),
    ...(values["announce-from"] ? { announceFrom: values["announce-from"] } : {}),
    ...(values.cell ? { cellIds: values.cell } : {}),
  };
}

async function confirmed(values: Values): Promise<boolean> {
  if (values.yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question("Create this notice? [y/N] ")).trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = readCommandLine();
  const [command, argument] = positionals;

  if (command === "list") {
    const { notices } = await admin<{ notices: DescribedNotice[] }>("GET");
    for (const notice of notices) {
      console.log(
        `${notice.id}  ${notice.state}  ${notice.kind}  ${notice.startsAt}  ${notice.summary}`
      );
    }
    if (notices.length === 0) console.log("No notices.");
    return;
  }

  if (command === "preview" || command === "create") {
    if (!argument) throw new Error(`${command} needs a kind: maintenance or incident`);
    // Checked before any request: the operator sees this refusal before a preview.
    if (
      command === "create" &&
      argument === "incident" &&
      !values.line?.length &&
      !values["no-mirror"]
    ) {
      throw new Error("an incident needs --line <status-line-slug>, or --no-mirror");
    }
    const fields = noticeFields(argument, values);
    const { preview } = await admin<{ preview: { coveredTenants: number; say: string } }>("POST", {
      action: "preview",
      ...fields,
    });
    console.log(`This notice reaches ${preview.coveredTenants} Exomem owner(s) by email.`);
    console.log(`The assistant is told: ${preview.say}`);
    if (command === "preview") return;
    if (!(await confirmed(values))) {
      console.log("Nothing was created.");
      return;
    }
    const { notice } = await admin<{ notice: DescribedNotice }>("POST", {
      action: "create",
      ...fields,
    });
    console.log(`Created ${notice.kind} notice ${notice.id} (${notice.state}).`);
    if (values["no-mirror"]) return;
    try {
      console.log(`Status issue: ${await openIssue(statusIssueFor(notice, values.line ?? []))}`);
    } catch (error) {
      console.error(
        `The notice is live, but the status issue was not created: ${error instanceof Error ? error.message : error}`
      );
      process.exitCode = 2;
    }
    return;
  }

  if (command === "cancel" || command === "resolve") {
    if (!argument) throw new Error(`${command} needs a notice id`);
    if (command === "resolve" && !values.account) {
      throw new Error('resolve needs --account "what happened, in one line"');
    }
    const { notice } = await admin<{ notice: DescribedNotice }>("POST", {
      action: command,
      id: argument,
    });
    console.log(`${command === "cancel" ? "Cancelled" : "Resolved"} notice ${notice.id}.`);
    if (values["no-mirror"]) return;
    try {
      const closed =
        command === "cancel"
          ? await closeIssueFor(notice, "This maintenance is cancelled.", "not planned")
          : await closeIssueFor(notice, values.account as string, "completed");
      console.log(`Closed status issue ${closed}.`);
    } catch (error) {
      console.error(
        `The notice is ${command === "cancel" ? "cancelled" : "resolved"}, but its status issue is still open: ${error instanceof Error ? error.message : error}`
      );
      process.exitCode = 2;
    }
    return;
  }

  throw new Error("use one of: list, preview, create, cancel, resolve (see the top of this file)");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("[service-notice] failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
