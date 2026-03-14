interface MessageDateDividerProps {
  label: string;
  dateTime?: string;
}

export default function MessageDateDivider({ label, dateTime }: MessageDateDividerProps) {
  return (
    <div className="dm-chat__date-divider" role="separator" aria-label={label}>
      <time className="dm-chat__date-divider-label" dateTime={dateTime}>
        {label}
      </time>
    </div>
  );
}
