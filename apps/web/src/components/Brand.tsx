/** Portal mark: a generic leaf-in-shield (deliberately not a government emblem) and the wordmark. */
export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <rect width="40" height="40" rx="10" fill="#1d4ed8" />
      <path d="M20 6l11 4v8.5c0 7.2-4.6 12.7-11 15.5C13.6 31.2 9 25.7 9 18.5V10l11-4z" fill="#0b2545" opacity="0.35" />
      <path d="M27 13c-9 0-14 5.2-14 11.6 0 1.4.3 2.6.8 3.4 1.2-4.6 4.6-8 9.2-9.8-3.6 2.4-6.2 5.8-7.2 10.2 1 .4 2 .6 3.1.6C25.2 29 27.8 21.8 27 13z" fill="#5eead4" />
    </svg>
  );
}

export function Brand({ light = false, compact = false }: { light?: boolean; compact?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <BrandMark />
      <div style={{ lineHeight: 1.15, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 17, color: light ? '#fff' : '#0b2545', whiteSpace: 'nowrap' }}>Swachh Seva</div>
        {!compact && (
          <div style={{ fontSize: 11.5, color: light ? '#9fb3d1' : '#475569', whiteSpace: 'nowrap', letterSpacing: '0.02em' }}>
            Grievance Portal · शिकायत पोर्टल
          </div>
        )}
      </div>
    </div>
  );
}
