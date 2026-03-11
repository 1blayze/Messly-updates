interface SpotifyIconProps {
  className?: string;
  size?: number;
  title?: string;
  monochrome?: boolean;
}

export default function SpotifyIcon({
  className,
  size = 20,
  title,
  monochrome = false,
}: SpotifyIconProps) {
  const resolvedSize = Number.isFinite(size) ? Math.max(8, Math.round(size)) : 20;

  if (monochrome) {
    return (
      <svg
        className={className}
        width={resolvedSize}
        height={resolvedSize}
        viewBox="0 0 24 24"
        fill="none"
        role={title ? "img" : undefined}
        aria-hidden={title ? undefined : true}
        xmlns="http://www.w3.org/2000/svg"
      >
        {title ? <title>{title}</title> : null}
        <path
          d="M6.75 8.95c3.85-1.16 7.67-.85 11.42.92"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
        <path
          d="M7.95 11.9c3.03-.86 5.99-.62 8.86.69"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
        <path
          d="M9.1 14.75c2.24-.58 4.42-.41 6.52.52"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg
      className={className}
      width={resolvedSize}
      height={resolvedSize}
      viewBox="0 0 24 24"
      fill="none"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="12" r="12" fill="currentColor" />
      <path
        d="M6.75 8.95c3.85-1.16 7.67-.85 11.42.92"
        stroke="#ffffff"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M7.95 11.9c3.03-.86 5.99-.62 8.86.69"
        stroke="#ffffff"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M9.1 14.75c2.24-.58 4.42-.41 6.52.52"
        stroke="#ffffff"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
