'use client';

import { useEffect, useState } from 'react';
import {
  CheckoutEventNames,
  initializePaddle,
  type Environments,
  type Paddle,
} from '@paddle/paddle-js';

type CompletionListener = () => void;

let paddlePromise: Promise<Paddle | null> | null = null;
const completionListeners = new Set<CompletionListener>();

function resolveEnvironment(): Environments {
  const raw = process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT;
  if (raw === 'sandbox' || raw === 'production') return raw;
  return 'production';
}

function loadPaddle(): Promise<Paddle | null> {
  if (paddlePromise) return paddlePromise;

  const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
  if (!token) {
    paddlePromise = Promise.resolve(null);
    console.error('[paddle] NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not set');
    return paddlePromise;
  }

  paddlePromise = initializePaddle({
    token,
    environment: resolveEnvironment(),
    eventCallback: (event) => {
      if (event.name === CheckoutEventNames.CHECKOUT_COMPLETED) {
        completionListeners.forEach((fn) => {
          try {
            fn();
          } catch (err) {
            console.error('[paddle] completion listener threw', err);
          }
        });
      }
    },
  })
    .then((instance) => instance ?? null)
    .catch((err) => {
      console.error('[paddle] failed to initialize', err);
      return null;
    });

  return paddlePromise;
}

export type HostedBackupCadence = 'monthly' | 'yearly';

export type UsePaddleResult = {
  ready: boolean;
  error: string | null;
  completed: boolean;
  openEndstateCheckout: () => Promise<void>;
  openSupporterCheckout: () => Promise<void>;
  openHostedBackupCheckout: (cadence: HostedBackupCadence) => Promise<void>;
  openTransactionCheckout: (transactionId: string) => Promise<void>;
};

const UNAVAILABLE_MESSAGE =
  'Checkout is unavailable right now. Please try again later.';

async function openCheckoutWith(
  open: (paddle: Paddle) => void,
): Promise<void> {
  const paddle = await loadPaddle();
  if (!paddle) {
    alert(UNAVAILABLE_MESSAGE);
    return;
  }
  try {
    open(paddle);
  } catch (err) {
    console.error('[paddle] failed to open checkout', err);
    alert(UNAVAILABLE_MESSAGE);
  }
}

export function usePaddle(): UsePaddleResult {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadPaddle().then((instance) => {
      if (cancelled) return;
      if (instance) {
        setReady(true);
      } else {
        setError('Checkout is unavailable right now.');
      }
    });

    const onComplete = () => setCompleted(true);
    completionListeners.add(onComplete);
    return () => {
      cancelled = true;
      completionListeners.delete(onComplete);
    };
  }, []);

  async function openEndstateCheckout(): Promise<void> {
    const priceId = process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_LIFETIME;
    if (!priceId) {
      console.error(
        '[paddle] NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_LIFETIME is not set',
      );
      alert(UNAVAILABLE_MESSAGE);
      return;
    }
    await openCheckoutWith((paddle) => {
      paddle.Checkout.open({ items: [{ priceId, quantity: 1 }] });
    });
  }

  async function openSupporterCheckout(): Promise<void> {
    const priceId = process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER;
    if (!priceId) {
      console.error(
        '[paddle] NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER is not set',
      );
      alert(UNAVAILABLE_MESSAGE);
      return;
    }
    await openCheckoutWith((paddle) => {
      paddle.Checkout.open({ items: [{ priceId, quantity: 1 }] });
    });
  }

  async function openHostedBackupCheckout(
    cadence: HostedBackupCadence,
  ): Promise<void> {
    const envName =
      cadence === 'yearly'
        ? 'NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_YEARLY'
        : 'NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_MONTHLY';
    const priceId =
      cadence === 'yearly'
        ? process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_YEARLY
        : process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_MONTHLY;
    if (!priceId) {
      console.error(`[paddle] ${envName} is not set`);
      alert(UNAVAILABLE_MESSAGE);
      return;
    }
    await openCheckoutWith((paddle) => {
      paddle.Checkout.open({ items: [{ priceId, quantity: 1 }] });
    });
  }

  async function openTransactionCheckout(
    transactionId: string,
  ): Promise<void> {
    await openCheckoutWith((paddle) => {
      paddle.Checkout.open({ transactionId });
    });
  }

  return {
    ready,
    error,
    completed,
    openEndstateCheckout,
    openSupporterCheckout,
    openHostedBackupCheckout,
    openTransactionCheckout,
  };
}
