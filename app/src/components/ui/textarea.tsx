import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Grows with its text up to whatever max-height the caller gives it. Dragging the corner writes a
 * height into the element's own style, and from then on the cap is lifted, so the person can make
 * a long text taller than it opens; the field spans its container, so it is only dragged taller.
 */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      dir="auto"
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full resize-y [&[style*=height]]:max-h-none rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
