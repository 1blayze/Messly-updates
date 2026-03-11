import messlyIcon from "../assets/icons/app/messly-icon.svg";
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
        <div className="app-bootstrap-screen__logo-wrap" aria-hidden="true">
          <img src={messlyIcon} alt="" className="app-bootstrap-screen__logo" draggable={false} />
        </div>
        <h1 className="app-bootstrap-screen__title">Messly</h1>
        <p className="app-bootstrap-screen__status">{effectiveStatus}</p>
        <p className="app-bootstrap-screen__detail">{effectiveDetail}</p>
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
