"use client";

import { useRef, useState, type Ref } from "react";
import { Button } from "@/components/exomem/Button";
import { IconButton } from "@/components/exomem/IconButton";
import { Switch } from "@/components/exomem/Switch";
import { TextField } from "@/components/exomem/TextField";
import { ORIGIN_LABEL_MAX } from "@/lib/exomem/cloud-filing-contract";
import {
  dropEntries,
  GITIGNORE_MAX_BYTES,
  pickedFromEntries,
  pickedFromFiles,
  type ImportSelection,
  type IncludeChoices,
  type LeftOutReason,
  type PickedItem,
} from "@/lib/exomem-hosted/cloud-import-selection";
import { byteSize, count } from "./home-format";
import { LeftOutList } from "./home-import-filing";
import local from "./home-import.module.css";
import dialog from "./home-storage.module.css";

const REASONS: Record<LeftOutReason, string> = {
  hidden: "Hidden file",
  gitignored: "Excluded by .gitignore",
  "zip-encrypted": "Encrypted in the zip",
  "zip-unsupported": "Compression not supported",
  "zip-unsafe-name": "Unsafe name in the zip",
  "zip-repeated-name": "Repeated name in the zip",
  "zip-link": "Link in the zip",
  "zip-unreadable": "Zip could not be opened",
};

function filesWord(value: number): string {
  return `${count(value)} file${value === 1 ? "" : "s"}`;
}

/** Whether a drag carries files from the device, rather than text or a link. */
export function carriesFiles(data: DataTransfer | null): boolean {
  return Array.from(data?.types ?? []).includes("Files");
}

/** The picks a drop makes; the entries are taken now, while the drop event runs. */
export function droppedItems(data: DataTransfer): Promise<PickedItem[]> {
  const entries = dropEntries(data);
  return entries ? pickedFromEntries(entries) : Promise.resolve(pickedFromFiles([...data.files]));
}

function UploadMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="26"
      height="26"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={local.mark}
    >
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
    </svg>
  );
}

/**
 * Where the person adds files: a drop zone that also opens the pickers. A phone has no drag
 * and drop and no folder picker, so it shows one picker, which opens the photo library and files.
 */
export function ImportPicker({
  reading,
  again,
  compact,
  chooseButton,
  onPick,
}: {
  reading: boolean;
  /** An open import waits for the same selection, chosen again. */
  again: boolean;
  /** Something is chosen or shown above: the zone adds more and takes less room. */
  compact: boolean;
  chooseButton: Ref<HTMLButtonElement>;
  onPick: (items: Promise<PickedItem[]>) => void;
}) {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const take = (input: HTMLInputElement) => {
    const chosen = [...(input.files ?? [])];
    input.value = "";
    if (chosen.length) onPick(Promise.resolve(pickedFromFiles(chosen)));
  };
  return (
    <div
      className={[local.dropZone, compact && local.compact, over && local.dropOver]
        .filter(Boolean)
        .join(" ")}
      onDragEnter={(event) => {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        // The page's own drop handler would add the same files a second time.
        event.stopPropagation();
        setOver(false);
        onPick(droppedItems(event.dataTransfer));
      }}
    >
      {!compact && <UploadMark />}
      <span className={local.dropTitle}>
        {again ? (
          "Choose the same files again"
        ) : compact ? (
          <>
            <span className={local.fine}>Drop more, or choose</span>
            <span className={local.coarse}>Add more</span>
          </>
        ) : (
          <>
            <span className={local.fine}>Drop files, folders or zips</span>
            <span className={local.coarse}>Photos, files or zips</span>
          </>
        )}
      </span>
      <div className={local.dropActions}>
        <Button
          ref={chooseButton}
          size="account"
          working={reading}
          onClick={() => files.current?.click()}
        >
          {reading ? (
            "Reading…"
          ) : (
            <>
              <span className={local.fine}>Choose files</span>
              <span className={local.coarse}>Choose photos or files</span>
            </>
          )}
        </Button>
        {!reading && (
          <span className={local.fine}>
            <Button size="account" onClick={() => folder.current?.click()}>
              Choose a folder
            </Button>
          </span>
        )}
      </div>
      {!compact && <span className={local.dropNote}>Encrypted on this device</span>}
      <input
        ref={files}
        type="file"
        multiple
        className="sr-only"
        aria-label="Files to add"
        // The visible buttons open these; an invisible control must not take focus.
        tabIndex={-1}
        onChange={(event) => take(event.currentTarget)}
      />
      <input
        ref={(node) => {
          folder.current = node;
          node?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        multiple
        className="sr-only"
        aria-label="Folder to add"
        tabIndex={-1}
        onChange={(event) => take(event.currentTarget)}
      />
    </div>
  );
}

/** What the selection sends, what it leaves out and why, and the person's optional label. */
export function SelectionSummary({
  selection,
  include,
  label,
  onInclude,
  onRemove,
  onLabel,
}: {
  selection: ImportSelection;
  include: IncludeChoices;
  label: string;
  onInclude: (next: IncludeChoices) => void;
  /** Removes picks by their archive names. */
  onRemove: (names: string[]) => void;
  onLabel: (label: string) => void;
}) {
  const loose = selection.parts.filter(({ kind }) => kind === "file");
  const grouped = selection.parts.filter(({ kind }) => kind !== "file");
  const looseTotals = loose.reduce(
    (total, { included }) => ({
      files: total.files + included.files,
      bytes: total.bytes + included.bytes,
    }),
    { files: 0, bytes: 0 }
  );
  const skipped = selection.skippedRules;
  return (
    <>
      <p className={local.headline} role="status">
        {selection.files.length === 0
          ? "Nothing to send"
          : `${filesWord(selection.included.files)} · ${byteSize(selection.included.bytes)}`}
      </p>
      <ul className={local.parts}>
        {grouped.map((part) => (
          <li key={part.name}>
            <span className={local.partName}>
              {part.name}/
              {part.kind === "zip" && <span className={local.partFrom}>{part.source}</span>}
            </span>
            <span className={local.partTotals}>
              {filesWord(part.included.files)} · {byteSize(part.included.bytes)}
            </span>
            <IconButton label={`Remove ${part.source}`} onClick={() => onRemove([part.name])}>
              ×
            </IconButton>
          </li>
        ))}
        {loose.length > 0 && (
          <li>
            <span className={local.partName}>
              {loose.length === 1 ? loose[0].name : "Files"}
            </span>
            <span className={local.partTotals}>
              {filesWord(looseTotals.files)} · {byteSize(looseTotals.bytes)}
            </span>
            <IconButton
              label={loose.length === 1 ? `Remove ${loose[0].source}` : "Remove the files"}
              onClick={() => onRemove(loose.map(({ name }) => name))}
            >
              ×
            </IconButton>
          </li>
        )}
      </ul>
      <LeftOutList
        total={selection.leftOut.length}
        items={selection.leftOut.map(({ path, reason }) => ({ path, reason: REASONS[reason] }))}
      />
      {selection.gitignored.files > 0 && (
        <Switch
          label="Include items .gitignore excludes"
          description={`${filesWord(selection.gitignored.files)} · ${byteSize(selection.gitignored.bytes)}`}
          checked={include.gitignored}
          onChange={(gitignored) => onInclude({ gitignored })}
        />
      )}
      {skipped > 0 && (
        <p className={dialog.text}>
          .gitignore files over {byteSize(GITIGNORE_MAX_BYTES)}, rules not applied:{" "}
          {count(skipped)}
        </p>
      )}
      <TextField
        label="Where is this from?"
        hint="Optional"
        value={label}
        maxLength={ORIGIN_LABEL_MAX}
        autoComplete="off"
        onChange={(event) => onLabel(event.currentTarget.value)}
      />
    </>
  );
}
