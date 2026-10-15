/* Exomem components: the brand marks, the alive graph, controls, and the transitions every state change uses.
   React 18. Styles: bundle.css (tokens only). Every state change is animated by the browser from numbers or
   cross-fades; nothing swaps abruptly. Reduced motion: values jump, nothing travels. */
import * as React from 'react';
import { FULL, FULL_ROW, SMALL, SMALL_ROW, PRESETS, WORD_PATH } from './geometry';
import './alive-engine.js';

const { useState, useEffect, useLayoutEffect, useRef, useId } = React;
const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

/* ---------------------------------------------------------------- the writing E */

export type MarkState = 'rest' | 'recall' | 'save' | 'working' | 'progress' | 'done' | 'failed' | 'off';

/** Where each step ends along the stroke of L dots. */
export function stepEnds(L: number, n: number): number[] {
  const p = PRESETS[L] && PRESETS[L][n];
  return p ? p : Array.from({ length: n }, (_, i) => Math.round(((i + 1) * L) / n * 100) / 100);
}

/** The three numbers for a state. step i of n running (0-based); i >= n means all done. */
export function markNumbers(L: number, state: MarkState, opts: { steps?: number; step?: number; value?: number } = {}) {
  if (state === 'working') return { w: 0, b: L, rest: 0, cls: 'indet' };
  if (state === 'done') return { w: L, b: L, rest: 0, cls: 'done' };
  if (state === 'failed') return { w: 0, b: 0, rest: 0, cls: '' };
  if (state === 'progress') {
    if (typeof opts.value === 'number') {
      const v = Math.max(0, Math.min(1, opts.value)), w = Math.round(L * v * 100) / 100;
      return { w, b: Math.min(L, w + 1), rest: 0, cls: v >= 1 ? 'done' : '' };
    }
    const n = Math.max(1, opts.steps ?? 1), i = Math.max(0, opts.step ?? 0), e = stepEnds(L, n);
    return i >= n ? { w: L, b: L, rest: 0, cls: 'done' } : { w: i ? e[i - 1] : 0, b: e[i], rest: 0, cls: '' };
  }
  const cls = state === 'recall' ? 'recall' : state === 'save' ? 'save' : state === 'off' ? 'off' : 'breathe';
  return { w: 0, b: 0, rest: 1, cls };
}

/** 'failed' un-writes the stroke, then rests. */
function useSettled(state: MarkState): MarkState {
  const [s, setS] = useState(state);
  useEffect(() => {
    setS(state);
    if (state !== 'failed') return;
    const t = setTimeout(() => setS('rest'), 950);
    return () => clearTimeout(t);
  }, [state]);
  return s;
}

function Dots({ pts, row, r }: { pts: [number, number][]; row: number[]; r: number }) {
  const c = pts.map(([x, y], k) => (
    <circle key={k} cx={x} cy={y} r={r} style={{ ['--exo-k' as any]: k, ['--exo-row' as any]: row.includes(k) ? 1 : 0 }} />
  ));
  return (<><g className="exo-we-i">{c}</g><g className="exo-we-l">{c}</g><g className="exo-we-p">{c}</g></>);
}

export interface MarkProps {
  /** Pixel size. Below 32 px the small cut is used. */
  size?: number;
  state?: MarkState;
  /** progress: how many steps, and which one is running (0-based; steps = done). */
  steps?: number;
  step?: number;
  /** progress: a fraction 0–1 instead of steps. */
  value?: number;
  /** At rest the middle row breathes. Set false for a still logo. */
  breathe?: boolean;
  /** Accessible name. Defaults to "Exomem". Pass null to hide it from assistive tech. */
  label?: string | null;
  small?: boolean;
  className?: string;
}

/** The Dot E, alive: the logo at rest, a meter that writes itself while work runs. */
export function Mark({ size = 40, state = 'rest', steps, step, value, breathe = true, label = 'Exomem', small, className }: MarkProps) {
  const s = useSettled(state);
  const sm = small ?? size < 32;
  const L = sm ? 10 : 18;
  const n = markNumbers(L, s, { steps, step, value });
  const cls = n.cls === 'breathe' && !breathe ? '' : n.cls;
  return (
    <svg className={cx('exo-we', cls, className)} viewBox="0 0 48 48" width={size} height={size}
      role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : true}
      style={{ ['--exo-L' as any]: L, ['--exo-w' as any]: n.w, ['--exo-b' as any]: n.b, ['--exo-rest' as any]: n.rest }}>
      {sm ? <Dots pts={SMALL} row={SMALL_ROW} r={3.1} /> : <Dots pts={FULL} row={FULL_ROW} r={2.2} />}
    </svg>
  );
}

export interface WordmarkProps extends Omit<MarkProps, 'size' | 'small'> {
  /** Height in px. The header uses 17. */
  height?: number;
}

/** The logo: the word Exomem with the Dot E as its capital. Every Mark state works here. */
export function Wordmark({ height = 17, state = 'rest', steps, step, value, breathe = false, label = 'Exomem', className }: WordmarkProps) {
  const s = useSettled(state);
  const n = markNumbers(18, s, { steps, step, value });
  const cls = n.cls === 'breathe' && !breathe ? '' : n.cls;
  return (
    <svg className={cx('exo-we exo-we-wm', cls, className)} viewBox="2.30 -27.92 139.90 28.40" height={height}
      role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : true}
      style={{ ['--exo-L' as any]: 18, ['--exo-w' as any]: n.w, ['--exo-b' as any]: n.b, ['--exo-rest' as any]: n.rest }}>
      <g transform="translate(-6.642 -32.782) scale(0.7843)"><Dots pts={FULL} row={FULL_ROW} r={2.2} /></g>
      <path className="exo-we-word" d={WORD_PATH} />
    </svg>
  );
}

/* ---------------------------------------------------------------- transitions */

export interface SwapProps { /** Change this to cross-fade to the new children. */ k: string | number; children?: React.ReactNode; block?: boolean; className?: string; }

/** Cross-fades text or any content when `k` changes: the old fades out while the new fades up in, in the same place. */
export function Swap({ k, children, block, className }: SwapProps) {
  const last = useRef<{ k: SwapProps['k']; c: React.ReactNode }>({ k, c: children });
  const [old, setOld] = useState<{ k: SwapProps['k']; c: React.ReactNode } | null>(null);
  useLayoutEffect(() => {
    if (last.current.k !== k) {
      setOld(last.current);
      last.current = { k, c: children };
      const t = setTimeout(() => setOld(null), 450);
      return () => clearTimeout(t);
    }
    last.current = { k, c: children };
  }, [k, children]);
  return (
    <span className={cx('exo-swap', block && 'exo-swap--block', className)}>
      {old && old.k !== k ? <span key={'o' + old.k} className="exo-swap-out" aria-hidden="true">{old.c}</span> : null}
      <span key={'n' + k} className={cx('exo-swap-in', !old && 'exo-swap-first')}>{children}</span>
    </span>
  );
}

export interface CrossfadeProps { /** The key of the pane to show. */ show: string; panes: Record<string, React.ReactNode>; className?: string; }

/** Panes share one place and cross-fade. The box keeps the tallest pane's height, so nothing below jumps. */
export function Crossfade({ show, panes, className }: CrossfadeProps) {
  return (
    <div className={cx('exo-xfade', className)}>
      {Object.entries(panes).map(([key, node]) => (
        <div key={key} className={cx('exo-xfade-pane', key === show && 'is-on')} aria-hidden={key === show ? undefined : true}
          {...(key === show ? {} : { inert: '' as any })}>{node}</div>
      ))}
    </div>
  );
}

export interface CollapseProps { open: boolean; children?: React.ReactNode; className?: string; }

/** Opens and closes to its content's height (an error message, a notice), without measuring. */
export function Collapse({ open, children, className }: CollapseProps) {
  return (
    <div className={cx('exo-collapse', open && 'is-open', className)} aria-hidden={open ? undefined : true}>
      <div>{children}</div>
    </div>
  );
}

/** Fades content up in when it mounts. */
export function FadeIn({ children, className, delay = 0 }: { children?: React.ReactNode; className?: string; delay?: number }) {
  return <div className={cx('exo-fadein', className)} style={delay ? { animationDelay: delay + 'ms' } : undefined}>{children}</div>;
}

/** A placeholder block while data loads. */
export function Skeleton({ width = '100%', height = 14, radius = 4, className }: { width?: number | string; height?: number | string; radius?: number; className?: string }) {
  return <span className={cx('exo-skel', className)} aria-hidden="true" style={{ width, height, borderRadius: radius }} />;
}

/* ---------------------------------------------------------------- controls */

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'amber' | 'ghost';
  /** panel: 36 px. page: 46 px, a page's main action. */
  size?: 'panel' | 'page';
  /** While true the label cross-fades to workingLabel and the button is busy. */
  working?: boolean;
  workingLabel?: React.ReactNode;
}

export function Button({ variant = 'secondary', size = 'panel', working = false, workingLabel, children, className, disabled, ...rest }: ButtonProps) {
  return (
    <button type="button" {...rest} disabled={disabled} aria-busy={working || undefined}
      className={cx('exo-btn', `exo-btn--${variant}`, `exo-btn--${size}`, working && 'is-working', className)}>
      <Swap k={working ? 'w' : 'i'}>{working ? (workingLabel ?? children) : children}</Swap>
    </button>
  );
}

export interface TextFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: string;
  value?: string;
  onChange?: (value: string) => void;
  /** Returns a message (under ~45 characters, saying what to do) or nothing when the value is fine. */
  validate?: (value: string) => string | undefined | null;
  hint?: string;
  /** A server error for this field (a wrong password). Shown in the same line. */
  error?: string | null;
  optional?: boolean;
  /** Read-only with a real Change button inside the field. */
  onChangeRequest?: () => void;
  /** Bump this number when the form is submitted: the field judges itself now. */
  checkSignal?: number;
}

/** A text field that follows the Exomem validation rules: judged when you leave it, re-checked as you fix it. */
export function TextField({ label, value, onChange, validate, hint, error, optional, onChangeRequest, checkSignal, id, readOnly, className, ...rest }: TextFieldProps) {
  const autoId = useId();
  const fid = id ?? 'exo-f' + autoId;
  const [local, setLocal] = useState(value ?? '');
  const v = value ?? local;
  const [shown, setShown] = useState<string | null>(null);
  const judged = useRef(false);
  const judge = (x: string) => { const m = validate ? validate(x) : null; setShown(m || null); judged.current = true; return m; };
  useEffect(() => { if (checkSignal) judge(v); }, [checkSignal]);
  const msg = error || shown;
  const ro = readOnly || !!onChangeRequest;
  return (
    <div className={cx('exo-tf', className)}>
      <label className="exo-tf-label" htmlFor={fid}>{label}{optional ? <span className="exo-tf-opt"> (optional)</span> : null}</label>
      <div className="exo-tf-box">
        <input id={fid} className={cx('exo-field', ro && 'is-ro')} value={v} readOnly={ro}
          aria-invalid={msg ? true : undefined} aria-describedby={fid + '-line'}
          onChange={(e) => { const x = e.target.value; setLocal(x); onChange && onChange(x); if (shown) judge(x); }}
          onBlur={() => { if (!ro && v !== '') judge(v); }} {...rest} />
        {onChangeRequest ? <button type="button" className="exo-tf-change" onClick={onChangeRequest}>Change</button> : null}
      </div>
      <div id={fid + '-line'} className={cx('exo-field-line', msg && 'is-error')} aria-live="polite">
        <Swap k={msg ? 'e:' + msg : 'h'}>{msg || hint || ''}</Swap>
      </div>
    </div>
  );
}

export interface SwitchProps { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string; disabled?: boolean; }

/** The whole row is the control. */
export function Switch({ checked, onChange, label, description, disabled }: SwitchProps) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={cx('exo-switch', checked && 'is-on')} onClick={() => onChange(!checked)}>
      <span className="exo-switch-text"><span className="exo-switch-label">{label}</span>{description ? <span className="exo-switch-desc">{description}</span> : null}</span>
      <span className="exo-switch-track" aria-hidden="true"><span className="exo-switch-knob" /></span>
    </button>
  );
}

/* ---------------------------------------------------------------- live state */

export interface LiveLineProps { text: string; live?: boolean; onToggle?: () => void; }

/** A live line: an amber dot that blinks while something is live, and what is happening, in one line. */
export function LiveLine({ text, live = true, onToggle }: LiveLineProps) {
  return (
    <div className={cx('exo-live', live && 'is-live')} role="status">
      <span className="exo-live-dot" aria-hidden="true" />
      <span className="exo-live-text"><Swap k={text}>{text}</Swap></span>
      {onToggle ? <button type="button" className="exo-btn exo-btn--ghost exo-btn--panel" onClick={onToggle}>{live ? 'Pause' : 'Resume'}</button> : null}
    </div>
  );
}

export interface ProgressProps {
  /** One label per step, in order. */
  steps: string[];
  /** The running step (0-based). steps.length = done. */
  step: number;
  doneLabel?: string;
  /** Set to a message to un-write the E and show it. */
  failed?: string | null;
  /** Show "2 of 4 · " before the label. */
  count?: boolean;
  size?: number;
}

/** A status line for any process: the writing E beside what is happening now. */
export function Progress({ steps, step, doneLabel = 'Done', failed, count = false, size = 22 }: ProgressProps) {
  const n = steps.length, done = step >= n;
  const text = failed ? failed : done ? doneLabel : (count ? `${step + 1} of ${n} · ` : '') + steps[step];
  return (
    <div className="exo-progress" role="status">
      <Mark size={size} state={failed ? 'failed' : done ? 'done' : 'progress'} steps={n} step={step} label={null} />
      <span className="exo-progress-text"><Swap k={text}>{text}</Swap></span>
    </div>
  );
}

export interface StepsProps { items: { label: string; state: 'done' | 'now' | 'next' }[]; }

/** A short list of what happens next: done (✓), now (amber, pulsing), next (a ring). */
export function Steps({ items }: StepsProps) {
  return (
    <ol className="exo-steps">
      {items.map((it, i) => (
        <li key={i} className={cx('exo-step', 'is-' + it.state)}>
          <span className="exo-step-mark" aria-hidden="true">{it.state === 'done' ? '✓' : ''}</span>
          <Swap k={it.label}>{it.label}</Swap>
          <span className="exo-sr">{it.state === 'done' ? ' (done)' : it.state === 'now' ? ' (now)' : ''}</span>
        </li>
      ))}
    </ol>
  );
}

export interface NoticeProps { title: string; children?: React.ReactNode; action?: React.ReactNode; open?: boolean; }

/** A card with one thing to know and at most one action. Opens and closes with Collapse. */
export function Notice({ title, children, action, open = true }: NoticeProps) {
  return (
    <Collapse open={open}>
      <div className="exo-notice" role="status">
        <div className="exo-notice-body"><span className="exo-notice-title">{title}</span>{children ? <span className="exo-notice-text">{children}</span> : null}</div>
        {action ? <div className="exo-notice-action">{action}</div> : null}
      </div>
    </Collapse>
  );
}

/* ---------------------------------------------------------------- the alive graph */

declare global { interface Window { __exoAlive?: { scan(): void; fire(sel: string, ev: AliveEvent): void } } }
export interface AliveEvent { kind: 'recall' | 'save' | 'connect' | 'work'; on?: boolean; amber?: boolean; from?: number; of?: number; clear?: string; toward?: string; }

export interface AliveGraphProps {
  /** Notes [x, y, r] and links [i, j] in viewBox units. */
  nodes: [number, number, number?][];
  edges: [number, number][];
  viewBox: string;
  /** live: ink walks the links at rest (never amber). still: drawn, not moving. cut: can't reach Exomem: faded, no hover. */
  state?: 'live' | 'still' | 'cut';
  /** The walker is ink (Home). */
  inkWalker?: boolean;
  hover?: boolean;
  /** Where events come from by default, "x,y". */
  entry?: string;
  /** A unique key, used to fire events at this graph. */
  id: string;
  className?: string;
  style?: React.CSSProperties;
}

const readVar = (name: string, fb: string) => {
  if (typeof document === 'undefined') return fb;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fb;
};

/** The graph behind every Exomem surface. At rest ink pulses fill link by link; events light amber only when something happened. */
export function AliveGraph({ nodes, edges, viewBox, state = 'live', inkWalker = true, hover = true, entry, id, className, style }: AliveGraphProps) {
  const [theme, setTheme] = useState(() => (typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') || 'dark' : 'dark'));
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(document.documentElement.getAttribute('data-theme') || 'dark'));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  const ink = readVar('--fg-primary', '#ece9e2'), amber = readVar('--exo-amber', '#ffb000');
  const graph = JSON.stringify({ n: nodes.map(([x, y, r]) => [x, y, r ?? 3]), e: edges });
  const live = state === 'live';
  return (
    <svg key={theme + ink} className={cx('exo-graph', 'is-' + state, className)} style={style} viewBox={viewBox} aria-hidden="true"
      data-alive={live ? 'loop' : 'off'} data-graph={graph} data-ink={ink} data-amber={amber} data-alive-key={id}
      data-walk={inkWalker ? 'ink' : undefined} data-hover={live && hover ? 'glow' : undefined} data-entry={entry}>
      {edges.map(([i, j], k) => nodes[i] && nodes[j] ? <line key={'e' + k} className="exo-graph-e" x1={nodes[i][0]} y1={nodes[i][1]} x2={nodes[j][0]} y2={nodes[j][1]} vectorEffect="non-scaling-stroke" /> : null)}
      {nodes.map(([x, y, r], k) => <circle key={'n' + k} className="exo-graph-n" cx={x} cy={y} r={r ?? 3} />)}
    </svg>
  );
}

/** Fire an event at an AliveGraph by its id: a recall, a save, a connection, or work on/off. Pair it with words on the page. */
export function fireAlive(id: string, ev: AliveEvent) {
  if (typeof window !== 'undefined' && window.__exoAlive) window.__exoAlive.fire(`svg[data-alive-key="${id}"]`, ev);
}
