import { ROUTINE_VAR_MAX } from '@leafbot/shared';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n';

/**
 * Asks for the values a run of a routine with inputs starts with, each filled in with the
 * routine's usual one, so a run can be about something else this once without changing the routine.
 */
export function RunInputs({
  open,
  onOpenChange,
  inputs,
  onRun,
  pending,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The routine's inputs, with their usual values. */
  inputs: Record<string, string>;
  onRun(values: Record<string, string>): void;
  pending?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        // The Escape that closes it stops here, as a box's window's does: the canvas covering the
        // window listens for Escape to leave full screen.
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        {/* Drawn afresh each time it opens, so it starts from the usual values again. */}
        {open && (
          <Fields inputs={inputs} onRun={onRun} onCancel={() => onOpenChange(false)} pending={pending} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Fields({
  inputs,
  onRun,
  onCancel,
  pending,
}: {
  inputs: Record<string, string>;
  onRun(values: Record<string, string>): void;
  onCancel(): void;
  pending?: boolean;
}) {
  const t = useT();
  const [values, setValues] = useState(inputs);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        // Drawn over the routine's own form: its submit would save the routine as well.
        e.stopPropagation();
        onRun(values);
      }}
    >
      <div className="space-y-1">
        <DialogTitle>{t('routine.runWith')}</DialogTitle>
        <DialogDescription>{t('routine.runWithHint')}</DialogDescription>
      </div>
      {Object.keys(inputs).map((name, i) => (
        <div key={name} className="space-y-1.5">
          <Label htmlFor={`run-input-${i}`}>{name}</Label>
          <Input
            id={`run-input-${i}`}
            value={values[name] ?? ''}
            maxLength={ROUTINE_VAR_MAX}
            autoFocus={i === 0}
            onChange={(e) => setValues({ ...values, [name]: e.target.value })}
            className="rounded-xl"
          />
        </div>
      ))}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" className="rounded-full" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full" disabled={pending}>
          <Play className="size-3.5" /> {t('panel.runNow')}
        </Button>
      </div>
    </form>
  );
}
