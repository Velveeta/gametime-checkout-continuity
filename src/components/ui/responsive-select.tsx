'use client';

import { useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

export interface ResponsiveSelectOption {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
}

interface ResponsiveSelectProps {
  label: string;
  description?: string;
  value: string;
  options: readonly ResponsiveSelectOption[];
  disabled?: boolean;
  name?: string;
  className?: string;
  onValueChange: (value: string) => void;
}

/** One controlled value, with native desktop and modal mobile presentations.
 * CSS chooses the surface so server rendering never guesses the viewport.
 */
export function ResponsiveSelect({
  label,
  description = 'Choose an option below.',
  value,
  options,
  disabled = false,
  name,
  className,
  onValueChange,
}: ResponsiveSelectProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const fieldset = useRef<HTMLFieldSetElement>(null);
  const selected = options.find((option) => option.value === value);
  const inactive = disabled || options.every((option) => option.disabled);

  return (
    <div className={cn('responsive-select', className)}>
      <div className="responsive-select-native">
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          name={name}
          value={value}
          disabled={inactive}
          onChange={(event) => onValueChange(event.target.value)}
        >
          {options.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="responsive-select-mobile">
        <span>{label}</span>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button
              variant="outline"
              className="responsive-select-trigger"
              disabled={inactive}
              aria-label={`${label} ${selected?.label ?? 'Choose'}`}
            >
              <span>{selected?.label ?? 'Choose'}</span>
              <ChevronDown size={16} aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="bottom"
            closeLabel={`Close ${label.toLowerCase()} selection`}
            onOpenAutoFocus={(event) => {
              const target =
                fieldset.current?.querySelector<HTMLInputElement>(
                  'input:checked:not(:disabled)',
                ) ??
                fieldset.current?.querySelector<HTMLInputElement>(
                  'input:not(:disabled)',
                );

              if (target) {
                event.preventDefault();
                target.focus();
              }
            }}
          >
            <SheetTitle>Choose {label.toLowerCase()}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
            <div className="responsive-select-scroll">
              <fieldset
                ref={fieldset}
                className="responsive-select-options"
                disabled={inactive}
              >
                <legend className="sr-only">{label}</legend>
                {options.map((option) => (
                  <label
                    key={option.value}
                    className="responsive-select-option"
                    data-selected={option.value === value}
                    data-disabled={option.disabled ?? false}
                  >
                    <input
                      type="radio"
                      name={`${id}-mobile`}
                      value={option.value}
                      checked={option.value === value}
                      disabled={option.disabled}
                      onChange={() => onValueChange(option.value)}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      {option.detail && <small>{option.detail}</small>}
                    </span>
                  </label>
                ))}
              </fieldset>
            </div>
            <Button onClick={() => setOpen(false)}>Done</Button>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
