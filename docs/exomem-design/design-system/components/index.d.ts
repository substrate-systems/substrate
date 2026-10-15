// Exomem components (window.Exomem). Generated from src/index.tsx. Documentation, not type-checked.
import type * as React from 'react';
export type MarkState = 'rest' | 'recall' | 'save' | 'working' | 'progress' | 'done' | 'failed' | 'off';
/** Where each step ends along the stroke of L dots. */
export declare function stepEnds(L: number, n: number): number[];
/** The three numbers for a state. step i of n running (0-based); i >= n means all done. */
export declare function markNumbers(L: number, state: MarkState, opts?: {
    steps?: number;
    step?: number;
    value?: number;
}): {
    w: number;
    b: number;
    rest: number;
    cls: string;
};
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
export declare function Mark({ size, state, steps, step, value, breathe, label, small, className }: MarkProps): React.JSX.Element;
export interface WordmarkProps extends Omit<MarkProps, 'size' | 'small'> {
    /** Height in px. The header uses 17. */
    height?: number;
}
/** The logo: the word Exomem with the Dot E as its capital. Every Mark state works here. */
export declare function Wordmark({ height, state, steps, step, value, breathe, label, className }: WordmarkProps): React.JSX.Element;
export interface SwapProps {
    k: string | number;
    children?: React.ReactNode;
    block?: boolean;
    className?: string;
}
/** Cross-fades text or any content when `k` changes: the old fades out while the new fades up in, in the same place. */
export declare function Swap({ k, children, block, className }: SwapProps): React.JSX.Element;
export interface CrossfadeProps {
    show: string;
    panes: Record<string, React.ReactNode>;
    className?: string;
}
/** Panes share one place and cross-fade. The box keeps the tallest pane's height, so nothing below jumps. */
export declare function Crossfade({ show, panes, className }: CrossfadeProps): React.JSX.Element;
export interface CollapseProps {
    open: boolean;
    children?: React.ReactNode;
    className?: string;
}
/** Opens and closes to its content's height (an error message, a notice), without measuring. */
export declare function Collapse({ open, children, className }: CollapseProps): React.JSX.Element;
/** Fades content up in when it mounts. */
export declare function FadeIn({ children, className, delay }: {
    children?: React.ReactNode;
    className?: string;
    delay?: number;
}): React.JSX.Element;
/** A placeholder block while data loads. */
export declare function Skeleton({ width, height, radius, className }: {
    width?: number | string;
    height?: number | string;
    radius?: number;
    className?: string;
}): React.JSX.Element;
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'amber' | 'ghost';
    /** panel: 36 px. page: 46 px, a page's main action. */
    size?: 'panel' | 'page';
    /** While true the label cross-fades to workingLabel and the button is busy. */
    working?: boolean;
    workingLabel?: React.ReactNode;
}
export declare function Button({ variant, size, working, workingLabel, children, className, disabled, ...rest }: ButtonProps): React.JSX.Element;
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
export declare function TextField({ label, value, onChange, validate, hint, error, optional, onChangeRequest, checkSignal, id, readOnly, className, ...rest }: TextFieldProps): React.JSX.Element;
export interface SwitchProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
    description?: string;
    disabled?: boolean;
}
/** The whole row is the control. */
export declare function Switch({ checked, onChange, label, description, disabled }: SwitchProps): React.JSX.Element;
export interface LiveLineProps {
    text: string;
    live?: boolean;
    onToggle?: () => void;
}
/** A live line: an amber dot that blinks while something is live, and what is happening, in one line. */
export declare function LiveLine({ text, live, onToggle }: LiveLineProps): React.JSX.Element;
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
export declare function Progress({ steps, step, doneLabel, failed, count, size }: ProgressProps): React.JSX.Element;
export interface StepsProps {
    items: {
        label: string;
        state: 'done' | 'now' | 'next';
    }[];
}
/** A short list of what happens next: done (✓), now (amber, pulsing), next (a ring). */
export declare function Steps({ items }: StepsProps): React.JSX.Element;
export interface NoticeProps {
    title: string;
    children?: React.ReactNode;
    action?: React.ReactNode;
    open?: boolean;
}
/** A card with one thing to know and at most one action. Opens and closes with Collapse. */
export declare function Notice({ title, children, action, open }: NoticeProps): React.JSX.Element;
declare global {
    interface Window {
        __exoAlive?: {
            scan(): void;
            fire(sel: string, ev: AliveEvent): void;
        };
    }
}
export interface AliveEvent {
    kind: 'recall' | 'save' | 'connect' | 'work';
    on?: boolean;
    amber?: boolean;
    from?: number;
    of?: number;
    clear?: string;
    toward?: string;
}
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
/** The graph behind every Exomem surface. At rest ink pulses fill link by link; events light amber only when something happened. */
export declare function AliveGraph({ nodes, edges, viewBox, state, inkWalker, hover, entry, id, className, style }: AliveGraphProps): React.JSX.Element;
/** Fire an event at an AliveGraph by its id: a recall, a save, a connection, or work on/off. Pair it with words on the page. */
export declare function fireAlive(id: string, ev: AliveEvent): void;
