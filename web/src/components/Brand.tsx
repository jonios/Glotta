import { cx } from './ui';

export const PRODUCT_NAME = 'Glotta';

/** Glotta speech-bubble mark plus the product name in live text. */
export function BrandLogo({ size = 36, showName = true, className }: { size?: number; showName?: boolean; className?: string }) {
  return (
    <span className={cx('flex min-w-0 items-center gap-3', className)}>
      <img src="/glotta-mark.svg" width={size} height={size} alt={showName ? '' : PRODUCT_NAME} className="shrink-0" />
      {showName && (
        <span className="truncate font-semibold leading-none tracking-[-0.02em]" style={{ fontSize: Math.round(size * 0.56) }}>
          Glotta
        </span>
      )}
    </span>
  );
}
