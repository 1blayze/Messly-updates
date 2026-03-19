interface AppShellFallbackProps {
  statusText?: string;
  detailText?: string;
}

export default function AppShellFallback({
  statusText = "Carregando Azyoons",
  detailText = "Preparando aplicativo",
}: AppShellFallbackProps) {
  return (
    <div
      className="app-shell startup-auth-surface"
      data-messly-startup-surface="shell"
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{ minHeight: "100vh" }}
    >
      <span style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>
        {statusText} - {detailText}
      </span>
    </div>
  );
}
