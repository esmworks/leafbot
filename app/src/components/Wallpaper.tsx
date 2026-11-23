import { useWallpaper } from '@/lib/wallpaper';

/**
 * The person's own picture behind the whole window, under a veil of the theme's background so the
 * words over it stay readable in light and dark. It sits behind the panes, which let it through
 * where `data-wallpaper` asks them to (index.css).
 */
export function Wallpaper() {
  const url = useWallpaper((s) => s.url);
  if (!url) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 select-none">
      <img src={url} alt="" draggable={false} className="size-full object-cover" />
      <div className="absolute inset-0 bg-background opacity-(--wallpaper-dim)" />
    </div>
  );
}
