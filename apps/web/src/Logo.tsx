/**
 * Tollgate mark: a "T" made of a toll-gate arm (with its pivot) and a torn receipt.
 * The same drawing is used for the favicon (public/favicon.svg).
 */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="16" fill="#4F46E5" />
      <rect x="11" y="13" width="42" height="11" rx="5.5" fill="#fff" />
      <circle cx="16.5" cy="18.5" r="2.3" fill="#4F46E5" />
      <path d="M25 24h14v24l-2.8 3-2.8-3-2.8 3-2.8-3-2.8 3-2.8-3z" fill="#fff" />
      <rect x="28.5" y="30" width="7" height="2.2" rx="1.1" fill="#4F46E5" opacity=".5" />
      <rect x="28.5" y="35.5" width="4.5" height="2.2" rx="1.1" fill="#4F46E5" opacity=".5" />
    </svg>
  );
}

/** Mark + "Tollgate." wordmark, linking home. */
export function Logo({ className }: { className?: string }) {
  return (
    <a href="/" className={`serif logo ${className ?? ""}`} aria-label="Tollgate home">
      <LogoMark size={30} className="logo-mark" />
      <span className="logo-word">Tollgate<span className="logo-dot">.</span></span>
    </a>
  );
}
