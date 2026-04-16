'use client';

import { useEffect, useState } from 'react';
import {
  CheckoutEventNames,
  initializePaddle,
  type Paddle,
} from '@paddle/paddle-js';

type CompletionListener = () => void;

let paddlePromise: Promise<Paddle | null> | null = null;
const completionListeners = new Set<CompletionListener>();

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
    environment: 'production',
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

export type UsePaddleResult = {
  ready: boolean;
  error: string | null;
  completed: boolean;
  openEndstateCheckout: () => Promise<void>;
};

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
      alert('Checkout is unavailable right now. Please try again later.');
      return;
    }
    const paddle = await loadPaddle();
    if (!paddle) {
      alert('Checkout is unavailable right now. Please try again later.');
      return;
    }
    try {
      paddle.Checkout.open({
        items: [{ priceId, quantity: 1 }],
      });
    } catch (err) {
      console.error('[paddle] failed to open checkout', err);
      alert('Checkout is unavailable right now. Please try again later.');
    }
  }

  return { ready, error, completed, openEndstateCheckout };
}
