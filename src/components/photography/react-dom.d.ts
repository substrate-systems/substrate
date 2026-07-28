declare module "react-dom" {
  import type { ReactNode, ReactPortal } from "react";

  export function createPortal(
    children: ReactNode,
    container: Element | DocumentFragment,
    key?: string | null
  ): ReactPortal;
}

declare module "react-dom/client" {
  import type { ErrorInfo, ReactNode } from "react";

  export type Root = {
    render(children: ReactNode): void;
    unmount(): void;
  };

  export function createRoot(container: Element | DocumentFragment): Root;

  export type HydrateRootOptions = {
    identifierPrefix?: string;
    onCaughtError?: (error: unknown, errorInfo: ErrorInfo) => void;
    onUncaughtError?: (error: unknown, errorInfo: ErrorInfo) => void;
    onRecoverableError?: (error: unknown, errorInfo: ErrorInfo) => void;
  };

  export function hydrateRoot(
    container: Document | Element,
    initialChildren: ReactNode,
    options?: HydrateRootOptions
  ): Root;
}
