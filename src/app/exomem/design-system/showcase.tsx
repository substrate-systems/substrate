"use client";

import { useState, type ReactNode } from "react";
import { AddressField } from "@/components/exomem/AddressField";
import { Button } from "@/components/exomem/Button";
import { Card } from "@/components/exomem/Card";
import { FilterChip } from "@/components/exomem/FilterChip";
import { FlowField, type FieldKind } from "@/components/exomem/FlowField";
import { LiveLine } from "@/components/exomem/LiveLine";
import { Mark } from "@/components/exomem/Mark";
import { Modal } from "@/components/exomem/Modal";
import { Notice } from "@/components/exomem/Notice";
import { PairedTiles } from "@/components/exomem/PairedTiles";
import { PhoneSheet } from "@/components/exomem/PhoneSheet";
import { Popover } from "@/components/exomem/Popover";
import { Row } from "@/components/exomem/Row";
import { SegmentedSwitch } from "@/components/exomem/SegmentedSwitch";
import { Switch } from "@/components/exomem/Switch";
import { TagChip } from "@/components/exomem/TagChip";
import { TextField } from "@/components/exomem/TextField";
import { ThemeToggle } from "@/components/exomem/ThemeToggle";
import { Wordmark } from "@/components/exomem/Wordmark";
import type { ExomemTokenMap } from "@/lib/exomem/design-tokens";
import styles from "./design-system.module.css";

type Theme = "dark" | "light";

// Sample content for the showcase only, copied from the boards (R40, Journey, Home) and
// README Appendix C. Real screens take theirs from their own data.
const LEVELS = [
  {
    value: "off",
    label: "Off",
    description: "Exomem stays connected but waits. It searches or saves only when you ask it to.",
  },
  {
    value: "light",
    label: "Light",
    description:
      "Searches when you ask, or when the topic is clearly its. Saves only when you ask.",
  },
  {
    value: "balanced",
    label: "Balanced",
    description: "Searches when the topic matches. Saves conclusions. Stays quiet.",
  },
  {
    value: "maximal",
    label: "Maximal",
    description: "Searches before every real question. Saves every step forward, and says so.",
  },
] as const;
type Level = (typeof LEVELS)[number]["value"];
const MCP_ADDRESS = "https://substratesystems.io/api/exomem/mcp/v1";
const CLAUDE = { name: "Claude", glyph: "C", glyphSize: 20 };
const FIELD_KINDS: readonly FieldKind[] = ["quiet", "live", "hold", "go", "done", "stop"];
const MODAL_STEPS = {
  ask: "More storage",
  working: "Adding storage",
  done: "More storage added",
} as const;

function Section({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionHead}>
        <span className={styles.number}>{number}</span>
        <span className={styles.sectionTitle}>{title}</span>
      </h2>
      {children}
    </section>
  );
}

/** The same content in a dark and a light panel; each panel pins its own theme. */
function ThemePair({
  render,
  stacked = false,
}: {
  render: (theme: Theme) => ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={stacked ? styles.stack : styles.pair}>
      {(["dark", "light"] as const).map((theme) => (
        <div key={theme} className={`brand-exomem ${styles.panel}`} data-theme={theme}>
          <span className={styles.panelLabel}>{theme}</span>
          {render(theme)}
        </div>
      ))}
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.group}>
      <span className={styles.label}>{label}</span>
      {children}
    </div>
  );
}

function Controls() {
  const [level, setLevel] = useState<Level>("balanced");
  const [grow, setGrow] = useState(true);
  const [shown, setShown] = useState({
    supports: true,
    refines: true,
    contradicts: true,
    relates: false,
  });
  const toggle = (key: keyof typeof shown) => setShown((s) => ({ ...s, [key]: !s[key] }));
  const description = LEVELS.find((l) => l.value === level)?.description;
  return (
    <>
      <Group label="BUTTONS">
        <div className={styles.row}>
          <Button variant="primary">Connect</Button>
          <Button>Manage billing</Button>
          <Button variant="amber">Why is this true?</Button>
          <Button variant="ghost">← back</Button>
          <Button variant="primary" disabled>
            Send another link in 0:42
          </Button>
          <Button variant="primary" working>
            Connecting…
          </Button>
        </div>
        <div className={styles.column}>
          <Button variant="primary" size="page">
            Email me a link
          </Button>
        </div>
      </Group>
      <Group label="ICON BUTTON · THEME TOGGLE">
        <div className={styles.row}>
          <ThemeToggle />
        </div>
      </Group>
      <Group label="FILTER CHIPS">
        <div className={styles.row}>
          <FilterChip
            pressed={shown.supports}
            onClick={() => toggle("supports")}
            line={{ stroke: "var(--exo-amber)", width: 2, opacity: 0.9 }}
          >
            supports
          </FilterChip>
          <FilterChip
            pressed={shown.refines}
            onClick={() => toggle("refines")}
            line={{ stroke: "var(--exo-amber)", width: 1.4, dash: "1 3", opacity: 0.9 }}
          >
            refines
          </FilterChip>
          <FilterChip
            pressed={shown.contradicts}
            onClick={() => toggle("contradicts")}
            line={{ stroke: "var(--fg-primary)", width: 1.4, dash: "5 3", opacity: 0.9 }}
          >
            contradicts
          </FilterChip>
          <FilterChip
            pressed={shown.relates}
            onClick={() => toggle("relates")}
            line={{ stroke: "var(--fg-primary)", width: 1.4, opacity: 0.6 }}
          >
            relates to
          </FilterChip>
          <FilterChip review>19 to review</FilterChip>
        </div>
      </Group>
      <Group label="TAG CHIPS">
        <div className={styles.row}>
          <TagChip>decision</TagChip>
          <TagChip current>current</TagChip>
          <TagChip>#retrieval</TagChip>
        </div>
      </Group>
      <Group label="SEGMENTED SWITCH · PAGE AND ROW">
        <div className={styles.column}>
          <SegmentedSwitch
            label="How much your app uses Exomem"
            options={LEVELS}
            value={level}
            onChange={setLevel}
            description={description}
          />
          <SegmentedSwitch
            label="Coding agents"
            options={LEVELS}
            value={level}
            onChange={setLevel}
            size="row"
          />
        </div>
      </Group>
      <Group label="SWITCH · ON AND OFF">
        <div className={styles.column}>
          <Switch
            label="Grow automatically"
            description="When it fills up, add 10 GB and tell you. At most once a month."
            checked={grow}
            onChange={setGrow}
          />
          <Switch label="Grow automatically" checked={!grow} onChange={(on) => setGrow(!on)} />
        </div>
      </Group>
      <Group label="TEXT FIELDS · RESTING AND FAILED">
        <div className={styles.column}>
          <TextField label="Email" type="email" defaultValue="maria@example.com" />
          <TextField
            label="Reviewer password"
            type="password"
            defaultValue="wrong-password"
            error="That didn’t work. Check the username and password."
          />
        </div>
      </Group>
      <Group label="ADDRESS FIELD">
        <div className={styles.column}>
          <AddressField label="Address" address={MCP_ADDRESS} />
        </div>
      </Group>
    </>
  );
}

function Containers() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [modalStep, setModalStep] = useState<keyof typeof MODAL_STEPS | null>(null);
  return (
    <>
      <Group label="CARD">
        <div className={styles.column}>
          <Card>
            <span className={styles.cardTitle}>SUPERSEDES</span>
            <span className={styles.struck}>notes/old-plan.md</span>
            <span className={styles.cardTitle}>superseded 3 Aug · after run 014</span>
          </Card>
        </div>
      </Group>
      <Group label="NOTICES · QUIET AND ATTENTION">
        <div className={styles.column}>
          <Notice action={<Button>Status page ↗</Button>}>
            Saving is slow right now. Recall works, and nothing is lost. We’re fixing it.
          </Notice>
          <Notice attention action={<Button>Add storage</Button>}>
            Your Exomem is full (5 GB). Recall works; new saves wait for room. Add storage and they
            carry on. Nothing is ever deleted to make space.
          </Notice>
        </div>
      </Group>
      <Group label="ROWS">
        <div className={styles.column}>
          <Row title="research/embedding-models.md" meta="research" onSelect={() => {}} />
          <Row title="decisions/vault-layout.md" meta="decision" onSelect={() => {}} />
        </div>
      </Group>
      <Group label="POPOVER">
        <div className={styles.column}>
          <Popover label="Start from">
            <span className={styles.popoverHead}>START FROM</span>
            <Row title="research/embedding-models.md" meta="research" />
            <Row title="decisions/vault-layout.md" meta="decision" />
          </Popover>
        </div>
      </Group>
      <Group label="MODAL · ASK → WORKING → DONE">
        <div className={styles.row}>
          <Button onClick={() => setModalStep("ask")}>Open the modal</Button>
        </div>
        <Modal
          open={modalStep !== null}
          onClose={() => setModalStep(null)}
          title={MODAL_STEPS[modalStep ?? "ask"]}
        >
          {modalStep === "ask" && (
            <>
              <span className={styles.small}>Add room for more notes. Nothing is deleted.</span>
              <Button variant="primary" size="page" onClick={() => setModalStep("working")}>
                Continue
              </Button>
            </>
          )}
          {modalStep === "working" && (
            <Button variant="primary" size="page" working>
              Adding…
            </Button>
          )}
          {modalStep === "done" ? (
            <Button variant="primary" size="page" onClick={() => setModalStep(null)}>
              Done
            </Button>
          ) : (
            <Button
              variant="ghost"
              onClick={() => (modalStep === "working" ? setModalStep("done") : setModalStep(null))}
            >
              {modalStep === "working" ? "Show the done step" : "Not now"}
            </Button>
          )}
        </Modal>
      </Group>
      <Group label="PHONE SHEET · PEEK AND OPEN">
        <div className={styles.phone}>
          <PhoneSheet open={sheetOpen} onToggle={() => setSheetOpen((o) => !o)}>
            <span className={styles.sheetTitle}>Your knowledge</span>
            <span className={styles.small}>Pinch to zoom, drag to move.</span>
            {["research", "decisions", "sources", "people", "projects", "meetings"].map((name) => (
              <Row key={name} title={`${name}/`} meta="folder" />
            ))}
          </PhoneSheet>
        </div>
      </Group>
    </>
  );
}

function BrandAndLive() {
  const [paused, setPaused] = useState(false);
  return (
    <>
      <Group label="WORDMARK · MARK · MARK BREATHING">
        <div className={styles.row}>
          <Wordmark />
          <Mark size={40} label="Exomem" />
          <Mark size={34} status="on" label="Exomem, on" />
        </div>
      </Group>
      <Group label="LIVE LINE · LIVE AND PAUSED">
        <div className={styles.column}>
          <LiveLine paused={paused} onTogglePause={() => setPaused((p) => !p)}>
            Claude Code recalled 4 notes · 12 s ago
          </LiveLine>
          <LiveLine paused>Paused</LiveLine>
        </div>
      </Group>
      <Group label="PAIRED TILES · IDLE, CONNECTING, CONNECTED, STOPPED, FROM THE WEB">
        <div className={styles.column}>
          <PairedTiles state="idle" app={CLAUDE} />
          <PairedTiles state="connecting" app={CLAUDE} />
          <PairedTiles state="connected" app={CLAUDE} />
          <PairedTiles state="stopped" app={CLAUDE} />
          <PairedTiles state="idle" />
        </div>
      </Group>
    </>
  );
}

function Fields({
  kind,
  onKind,
  replay,
}: {
  kind: FieldKind;
  onKind: (kind: FieldKind) => void;
  replay: number;
}) {
  return (
    <>
      {/* The field takes the phone layout on a phone-sized screen, as it does on a page. */}
      <Group label="EVERY KIND · HOVER LIGHTS THE NEAREST NOTE">
        <div className={styles.row}>
          {FIELD_KINDS.map((k) => (
            <Button
              key={k}
              variant={k === kind ? "primary" : "secondary"}
              onClick={() => onKind(k)}
            >
              {k}
            </Button>
          ))}
        </div>
        <div className={`${styles.fieldFrame} ${styles.desktopField}`}>
          <FlowField key={`${kind}-${replay}`} kind={kind} />
        </div>
      </Group>
    </>
  );
}

export function DesignSystemShowcase({
  tokens,
}: {
  tokens: { dark: ExomemTokenMap; light: ExomemTokenMap };
}) {
  const [kind, setKind] = useState<FieldKind>("quiet");
  const [replay, setReplay] = useState(0);
  return (
    <main className={styles.page}>
      <div className={styles.intro}>
        <span className={styles.eyebrow}>Rendered from src/app/exomem/exomem-tokens.css</span>
        <h1 className={styles.title}>The Exomem design system</h1>
        <p className={styles.lede}>
          Every component in each of its states, dark and light side by side. Compare it with
          docs/exomem-design/reference/boards/R40-Design-System.dc.html.
        </p>
        <div className={styles.row}>
          <ThemeToggle />
          <Button variant="ghost" onClick={() => setReplay((r) => r + 1)}>
            Replay the animations
          </Button>
        </div>
      </div>

      <Section number="01" title="Colour">
        <ThemePair
          render={(theme) => (
            <div className={styles.tokens}>
              {Object.entries(tokens[theme]).map(([name, value]) => (
                <div key={name} className={styles.token}>
                  <span className={styles.swatch} style={{ background: `var(${name})` }} />
                  <span className={styles.tokenText}>
                    <span>{name}</span>
                    <span className={styles.tokenValue}>{value}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        />
      </Section>

      <Section number="04" title="Controls">
        <ThemePair render={() => <Controls key={replay} />} />
      </Section>

      <Section number="05" title="Containers">
        <ThemePair render={() => <Containers />} />
      </Section>

      <Section number="06" title="Brand and live">
        <ThemePair render={() => <BrandAndLive key={replay} />} />
      </Section>

      <Section number="07" title="The field">
        <ThemePair stacked render={() => <Fields kind={kind} onKind={setKind} replay={replay} />} />
      </Section>
    </main>
  );
}
