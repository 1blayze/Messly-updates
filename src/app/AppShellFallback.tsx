interface AppShellFallbackProps {
  statusText?: string;
  detailText?: string;
}

export default function AppShellFallback({
  statusText: _statusText = "Preparando interface",
  detailText: _detailText = "Carregando shell inicial do Messly",
}: AppShellFallbackProps) {
  return <div className="startup-auth-surface" data-messly-startup-surface="shell" aria-busy="true" />;
}
