import messlyIcon from "../assets/icons/ui/messly.svg";
import type { AppBootstrapPhase } from "../core/appBootstrap";

interface AppStartupScreenProps {
  statusText: string;
  detailText?: string | null;
  progress?: number | null;
  phase?: AppBootstrapPhase;
  errorText?: string | null;
}

function clampProgress(value: number | null | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, Number(value)));
}

export default function AppStartupScreen({
  statusText,
  detailText,
  progress,
  phase = "running",
  errorText,
}: AppStartupScreenProps) {
  const normalizedProgress = clampProgress(progress);
  const effectiveStatus = String(statusText ?? "").trim() || "Inicializando Messly";
  const effectiveDetail =
    String(errorText ?? "").trim() ||
    String(detailText ?? "").trim() ||
    (phase === "ready" ? "Abrindo interface" : "Aguarde alguns instantes");
  const progressScale = Math.max(normalizedProgress, 0.04);

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
        <div className="app-bootstrap-screen__progress-track" aria-hidden="true">
          <span
            className="app-bootstrap-screen__progress-fill"
            style={{ transform: `scale3d(${progressScale}, 1, 1)` }}
          />
        </div>
      </div>
    </section>
  );
}
