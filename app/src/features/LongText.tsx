import { Textarea } from '@/components/ui/textarea';

/**
 * A text a routine is told, such as its instruction or a step's: a field that grows with its text
 * up to the height its classes allow, then scrolls.
 */
export function LongText({
  value,
  onChange,
  label,
  placeholder,
  rows,
  className,
}: {
  value: string;
  onChange(next: string): void;
  /** What the text is, read out for the field. */
  label: string;
  placeholder?: string;
  rows: number;
  className?: string;
}) {
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
