import { Label } from '@/components/ui/label';
import { useT, type MessageKey } from '@/i18n';

/** A labelled form field; validation messages are message keys, shown in the current language. */
export function Field({
  label,
  error,
  children,
}: {
  label: string;
  /** A message key from the form schema, or text as it came. */
  error?: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <Label className="text-sm text-muted-foreground">{label}</Label>
      {children}
      {error && <p className="text-sm text-destructive">{t(error as MessageKey)}</p>}
    </div>
  );
}
