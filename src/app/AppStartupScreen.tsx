import messlyIcon from "../assets/icons/ui/messly.svg";
import type { AppBootstrapPhase } from "../core/appBootstrap";

interface AppStartupScreenProps {
  statusText: string;
  detailText?: string | null;
  progress?: number | null;
  phase?: AppBootstrapPhase;
  errorText?: string | null;
}

export default function AppStartupScreen({
  statusText,
  detailText,
  phase = "running",
  errorText,
}: AppStartupScreenProps) {
  const effectiveStatus = String(statusText ?? "").trim() || "Inicializando Azyoon";
  const effectiveDetail =
    String(errorText ?? "").trim() ||
    String(detailText ?? "").trim() ||
    (phase === "ready" ? "Abrindo interface" : "Aguarde alguns instantes");
  const visibleText = effectiveDetail || effectiveStatus;

  return (
    <section className={`app-bootstrap-screen app-bootstrap-screen--${phase}`} role="status" aria-live="polite">
      <div className="app-bootstrap-screen__backdrop" aria-hidden="true" />
      <div className="app-bootstrap-screen__content">
        <span className="app-bootstrap-screen__sr-only">
          {effectiveStatus} - {effectiveDetail}
        </span>
        <div className="app-bootstrap-screen__logo-wrap" aria-hidden="true">
          <img src={messlyIcon} alt="" className="app-bootstrap-screen__logo" draggable={false} />
        </div>
        <p className="app-bootstrap-screen__text">{visibleText}</p>
      </div>
    </section>
  );
}
