import type { ReactNode } from 'react';

/** Color follows the variant's name, so a filtered-out variant never repaints the others. */
export function toneClass(variant: string): string {
  if (variant === 'A') return 'dash-tone-a';
  if (variant === 'B') return 'dash-tone-b';
  return 'dash-tone-other';
}

export function VariantName({ variant }: { variant: string }) {
  return (
    <span className={`dash-variant ${toneClass(variant)}`}>
      <span className="dash-swatch" aria-hidden="true" />
      Variant {variant}
    </span>
  );
}

/** Horizontal bar for a share in [0, 1]. The value is always printed next to it, the bar only adds shape. */
export function Bar({ value, title }: { value: number | null; title?: string }) {
  const width = `${Math.max(0, Math.min(1, value ?? 0)) * 100}%`;
  return (
    <span className="dash-bar" title={title}>
      <span className="dash-bar-fill" style={{ width }} />
    </span>
  );
}

export function Tile({ label, value, detail, primary = false }: { label: string; value: string; detail?: ReactNode; primary?: boolean }) {
  return (
    <div className={primary ? 'dash-tile dash-tile-primary' : 'dash-tile'}>
      <div className="dash-tile-label">{label}</div>
      <div className="dash-tile-value">{value}</div>
      {detail !== undefined && <div className="dash-tile-detail">{detail}</div>}
    </div>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="dash-table-wrap">{children}</div>;
}
