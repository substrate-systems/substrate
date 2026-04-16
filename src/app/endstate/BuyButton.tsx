'use client';

import type { CSSProperties, ReactNode } from 'react';
import { usePaddle } from '@/lib/paddle';
import { c } from './_shared';

type Props = {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  completionLabel?: string;
};

export function BuyButton({
  children,
  className,
  style,
  completionLabel = 'Thanks — check your email for your license key.',
}: Props) {
  const { ready, completed, openEndstateCheckout } = usePaddle();

  if (completed) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={className}
        style={{
          ...style,
          background: 'rgba(45, 212, 191, 0.1)',
          color: c.teal,
          border: '1px solid rgba(45, 212, 191, 0.3)',
          cursor: 'default',
        }}
      >
        {completionLabel}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        void openEndstateCheckout();
      }}
      disabled={!ready}
      className={className}
      style={{
        border: 'none',
        cursor: ready ? 'pointer' : 'wait',
        opacity: ready ? 1 : 0.72,
        ...style,
      }}
    >
      {children}
    </button>
  );
}
