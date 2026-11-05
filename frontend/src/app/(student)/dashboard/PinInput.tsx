'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

export const PIN_LENGTH = 6;

export interface PinInputProps {
  value: string;
  onChange: (next: string) => void;
  /** Hamma raqam kiritilganda chaqiriladi (avtomatik yuborish). */
  onComplete?: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  className?: string;
}

/**
 * 6 xonali PIN uchun OTP uslubidagi input.
 *
 * Bitta yashirin `input` + 6 ta ko'rsatuvchi katak: mobil klaviatura,
 * `paste`, `autocomplete="one-time-code"` va screen-reader bilan to'g'ri ishlaydi.
 */
export function PinInput({
  value,
  onChange,
  onComplete,
  disabled = false,
  invalid = false,
  autoFocus = false,
  className,
}: PinInputProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [focused, setFocused] = React.useState(false);

  const digits = value.slice(0, PIN_LENGTH).split('');
  const activeIndex = Math.min(digits.length, PIN_LENGTH - 1);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const next = event.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH);
    onChange(next);
    if (next.length === PIN_LENGTH) onComplete?.(next);
  };

  return (
    <div
      className={cn('relative', className)}
      onClick={() => inputRef.current?.focus()}
      role="presentation"
    >
      <input
        ref={inputRef}
        value={value}
        onChange={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d*"
        maxLength={PIN_LENGTH}
        autoFocus={autoFocus}
        aria-label="Dars PIN kodi, 6 raqam"
        aria-invalid={invalid || undefined}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      />
      <div className="flex items-center justify-center gap-2 sm:gap-3" aria-hidden>
        {Array.from({ length: PIN_LENGTH }, (_, index) => {
          const digit = digits[index];
          const isActive = focused && !disabled && index === activeIndex && digits.length < PIN_LENGTH;
          const isFilledActive = focused && !disabled && digits.length === PIN_LENGTH;
          return (
            <div
              key={index}
              className={cn(
                'flex h-14 w-11 items-center justify-center rounded-xl border bg-surface-2 font-mono text-2xl font-semibold tabular-nums text-fg transition-[border-color,box-shadow] duration-150 sm:h-16 sm:w-12 sm:text-3xl',
                'border-border',
                (isActive || (isFilledActive && index === PIN_LENGTH - 1)) &&
                  // Faol katak = klaviatura fokusi → fokus nuri (DESIGN_GLOW §2).
                  'border-primary shadow-glow-primary',
                invalid && 'border-danger text-danger',
                disabled && 'opacity-60',
              )}
            >
              {digit ?? <span className="text-muted/40">·</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
