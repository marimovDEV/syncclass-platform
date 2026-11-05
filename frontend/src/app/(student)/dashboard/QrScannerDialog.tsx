'use client';

import * as React from 'react';
import { CameraOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { LoadingState } from '@/components/shared/states';

const SCANNER_ELEMENT_ID = 'syncclass-qr-reader';

/** Matndan 6 xonali PIN ni ajratib oladi (to'liq `join_url` ham bo'lishi mumkin). */
export function extractPinFromScan(text: string): string | null {
  const direct = text.trim();
  if (/^\d{6}$/.test(direct)) return direct;

  // `https://host/live/123456` yoki `.../?pin=123456`
  const fromPath = /\/live\/(\d{6})\b/.exec(direct);
  if (fromPath?.[1]) return fromPath[1];

  const fromQuery = /[?&]pin=(\d{6})\b/.exec(direct);
  if (fromQuery?.[1]) return fromQuery[1];

  const anyDigits = /(\d{6})/.exec(direct);
  return anyDigits?.[1] ?? null;
}

export interface QrScannerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** PIN topilganda chaqiriladi va dialog yopiladi. */
  onPin: (pin: string) => void;
}

/**
 * QR skaner. `html5-qrcode` faqat dialog ochilganda dinamik yuklanadi
 * (SSR da `window` yo'q va bundle kattalashmasin).
 */
export function QrScannerDialog({ open, onOpenChange, onPin }: QrScannerDialogProps) {
  const [status, setStatus] = React.useState<'idle' | 'starting' | 'running' | 'error'>('idle');
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;

    let cancelled = false;
    // `Html5Qrcode` instansiyasi — tip `import()` natijasidan olinadi.
    let scanner: { stop: () => Promise<void>; clear: () => void } | null = null;

    const start = async (): Promise<void> => {
      setStatus('starting');
      setMessage(null);
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (cancelled) return;

        const instance = new Html5Qrcode(SCANNER_ELEMENT_ID, { verbose: false });
        scanner = instance;

        await instance.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 220, height: 220 } },
          (decodedText: string) => {
            const pin = extractPinFromScan(decodedText);
            if (!pin) return;
            void instance.stop().catch(() => undefined);
            onPin(pin);
            onOpenChange(false);
          },
          () => {
            /* har kadrda "topilmadi" xabari keladi — e'tiborsiz qoldiramiz */
          },
        );
        if (!cancelled) setStatus('running');
      } catch (error) {
        if (cancelled) return;
        setStatus('error');
        setMessage(
          error instanceof Error && error.message.length > 0
            ? error.message
            : 'Kameraga ruxsat berilmadi.',
        );
      }
    };

    void start();

    return () => {
      cancelled = true;
      if (scanner) {
        void scanner
          .stop()
          .then(() => scanner?.clear())
          .catch(() => undefined);
      }
    };
  }, [open, onPin, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>QR kodni skanerlash</DialogTitle>
          <DialogDescription>
            O’qituvchi ekranidagi QR kodni kameraga tutib turing.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-hidden rounded-xl border border-border bg-scrim/90">
          <div id={SCANNER_ELEMENT_ID} className="min-h-56 w-full [&_video]:w-full" />
        </div>

        {status === 'starting' ? <LoadingState label="Kamera yoqilmoqda…" /> : null}

        {status === 'error' ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <CameraOff className="size-6 text-danger" aria-hidden />
            <p className="text-sm text-muted">
              {message ?? 'Kamera ishlamadi.'} PIN ni qo’lda kiritishingiz mumkin.
            </p>
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              Yopish
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
