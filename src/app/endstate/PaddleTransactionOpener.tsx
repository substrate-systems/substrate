'use client';

import { useEffect, useRef } from 'react';
import { usePaddle } from '@/lib/paddle';

export function PaddleTransactionOpener() {
  const { ready, openTransactionCheckout } = usePaddle();
  const openedRef = useRef(false);
  const txnRef = useRef<string | null>(null);

  if (txnRef.current === null && typeof window !== 'undefined') {
    txnRef.current = new URLSearchParams(window.location.search).get('_ptxn');
  }

  useEffect(() => {
    if (!ready) return;
    if (openedRef.current) return;
    const txn = txnRef.current;
    if (!txn) return;
    openedRef.current = true;
    void openTransactionCheckout(txn);
  }, [ready, openTransactionCheckout]);

  return null;
}
