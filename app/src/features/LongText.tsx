import { useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * A text a routine is told, such as its instruction or a step's. In the list it is a field that
 * grows with its text. A box on the flow is too small for a long text, and cannot grow without
 * covering the box under it, so there the box shows how the text starts and the whole text is
 * written in a window over the flow. What is typed there is kept as it is typed, like the field.
 */
export function LongText({
  value,
  onChange,
  label,
  placeholder,
  rows,
  inFlow,
  className,
}: {
  value: string;
  onChange(next: string): void;
  /** What the text is, read out for the field and shown on the window. */
  label: string;
  placeholder?: string;
  rows: number;
  /** In a box on the flow, rather than in the list. */
  inFlow?: boolean;
  /** The field's classes in the list. */
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  if (!inFlow) {
    return (
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className={className}
        aria-label={label}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${label}. ${t('flow.openText')}`}
        title={t('flow.openText')}
        className={cn(
          'group relative block w-full rounded-xl border border-input px-3 py-2 text-start text-sm shadow-xs',
          'outline-none transition-colors hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30',
        )}
      >
        <span
          dir="auto"
          className={cn(
            'line-clamp-6 pe-5 [overflow-wrap:anywhere] whitespace-pre-wrap',
            !value.trim() && 'text-muted-foreground',
          )}
        >
          {value.trim() ? value : (placeholder ?? label)}
        </span>
        <Maximize2
          className="absolute end-2 top-2 size-3.5 text-muted-foreground opacity-60 group-hover:opacity-100"
          aria-hidden
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-4rem)] flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
          </DialogHeader>
          <Textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            aria-label={label}
            autoFocus
            className="scroll-thin min-h-[50dvh] flex-1 overflow-y-auto rounded-xl text-sm leading-relaxed"
          />
          <DialogFooter>
            <Button type="button" className="rounded-xl" onClick={() => setOpen(false)}>
              {t('flow.textDone')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
