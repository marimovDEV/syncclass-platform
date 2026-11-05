'use client';

/**
 * `IMAGE` slaydi (CONTRACTS.md §16.1) — PDF sahifasi yoki yuklangan rasm.
 *
 * - `image_url` `parseSlides()` da `isAssetUrl()` dan o'tgan — faqat o'zimizning asset
 *   havolamiz, shuning uchun `<img src>` ga qo'yish xavfsiz.
 * - `object-contain`: rasm qirqilmaydi, to'liq ko'rinadi (PDF sahifasi o'qiladigan bo'lsin).
 * - Eski rasm 404 (`ASSET_NOT_FOUND`) bersa slayd YIQILMAYDI: aniq xabar + `alt` matni
 *   ko'rsatiladi, ya'ni mazmun baribir yetkaziladi.
 * - Faqat dizayn tokenlari (qayta dizaynga tayyor).
 */

import * as React from 'react';
import { ImageOff } from 'lucide-react';

import type { ImageSlide } from '@/types/api';
import { cn } from '@/lib/utils';
import { errorText } from '@/lib/format';
import { Skeleton } from '@/components/ui/skeleton';

type LoadState = 'loading' | 'ready' | 'error';

export interface ImageSlideViewProps {
  slide: ImageSlide;
  /** Mobil companion — kamroq padding. */
  compact?: boolean;
  className?: string;
}

export function ImageSlideView({ slide, compact = false, className }: ImageSlideViewProps) {
  const [state, setState] = React.useState<LoadState>('loading');
  const imageRef = React.useRef<HTMLImageElement | null>(null);

  // Slayd almashsa holat qaytadan boshlanadi; keshdan kelgan rasm `onLoad` ni o'tkazib
  // yuborgan bo'lishi mumkin — shuning uchun `complete` ham tekshiriladi.
  React.useEffect(() => {
    const node = imageRef.current;
    if (node !== null && node.complete) {
      setState(node.naturalWidth > 0 ? 'ready' : 'error');
      return;
    }
    setState('loading');
  }, [slide.image_url]);

  const hasTitle = typeof slide.title === 'string' && slide.title.length > 0;

  return (
    <figure
      className={cn(
        'flex h-full min-h-0 w-full flex-1 flex-col items-center gap-2',
        compact ? 'p-2' : 'p-4 studio:p-6',
        className,
      )}
    >
      {hasTitle ? (
        <figcaption className="w-full max-w-5xl shrink-0 text-xs font-semibold uppercase tracking-wider text-primary">
          {slide.title}
        </figcaption>
      ) : null}

      <div className="relative flex min-h-48 w-full flex-1 items-center justify-center overflow-hidden rounded-xl border border-border bg-surface">
        {state === 'loading' ? (
          <Skeleton className="absolute inset-0 rounded-xl" aria-hidden />
        ) : null}

        {state === 'error' ? (
          <div
            role="img"
            aria-label={slide.alt}
            className="flex max-w-md flex-col items-center gap-2 p-6 text-center"
          >
            <ImageOff className="size-8 text-muted" aria-hidden />
            <p className="text-sm font-medium text-fg">
              {errorText('ASSET_NOT_FOUND', 'Rasm topilmadi.')} Dars davom etadi.
            </p>
            {/* Rasm o'rniga uning tavsifi — mazmun yo'qolmasin. */}
            <p className="text-sm text-muted">{slide.alt}</p>
          </div>
        ) : (
          // Asset host dinamik (`BACKEND_PUBLIC_URL`) — `next/image` optimizatsiyasi uni Next
          // serveri orqali proksilardi; `isAssetUrl()` dan o'tgan oddiy `<img>` yetarli.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imageRef}
            src={slide.image_url}
            alt={slide.alt}
            decoding="async"
            draggable={false}
            onLoad={() => setState('ready')}
            onError={() => setState('error')}
            className={cn(
              'max-h-full max-w-full object-contain transition-opacity duration-slow',
              state === 'ready' ? 'opacity-100' : 'opacity-0',
            )}
          />
        )}
      </div>
    </figure>
  );
}
