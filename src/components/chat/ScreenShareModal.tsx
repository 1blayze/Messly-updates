import Modal from "../ui/Modal";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import "../../styles/components/ScreenShareModal.css";

type ScreenShareTab = "window" | "screen" | "device";

export interface ScreenShareModalSource {
  id: string;
  name: string;
  thumbnail?: string | null;
  appIcon?: string | null;
}

interface ScreenShareModalProps {
  isOpen: boolean;
  isLoading: boolean;
  sources: ScreenShareModalSource[];
  selectedSourceId: string | null;
  activeTab: ScreenShareTab;
  quality: string;
  onQualityChange: (value: string) => void;
  onTabChange: (tab: ScreenShareTab) => void;
  onSelectSource: (sourceId: string) => void;
  onClose: () => void;
  onConfirm: (sourceId?: string) => void;
}

const QUALITY_FPS_BY_RESOLUTION = {
  "480p": ["30"],
  "720p": ["30", "60"],
  "1080p": ["30", "60"],
  "1440p": ["30", "60"],
  "2160p": ["60"],
} as const;

type ResolutionKey = keyof typeof QUALITY_FPS_BY_RESOLUTION;
type FpsOption = "30" | "60";

function getFpsOptions(resolution: ResolutionKey): readonly FpsOption[] {
  return QUALITY_FPS_BY_RESOLUTION[resolution] as readonly FpsOption[];
}

function parseQuality(quality: string): { resolution: ResolutionKey; fps: FpsOption } {
  const match = quality.match(/^(480p|720p|1080p|1440p|2160p)(30|60)$/);
  if (!match) {
    return { resolution: "1080p", fps: "60" };
  }

  const resolution = match[1] as ResolutionKey;
  const fps = match[2] as FpsOption;
  const allowed = getFpsOptions(resolution);
  return {
    resolution,
    fps: allowed.includes(fps) ? fps : allowed[0],
  };
}

export default function ScreenShareModal({
  isOpen,
  isLoading,
  sources,
  selectedSourceId,
  activeTab,
  quality,
  onQualityChange,
  onTabChange,
  onSelectSource,
  onClose,
  onConfirm,
}: ScreenShareModalProps) {
  const { resolution, fps } = parseQuality(quality);
  const availableFps = getFpsOptions(resolution);
  const safeFps = availableFps.includes(fps) ? fps : availableFps[0];

  return (
    <Modal
      isOpen={isOpen}
      title="Compartilhar tela"
      onClose={onClose}
      panelClassName="dm-screen-share-modal"
      bodyClassName="dm-screen-share-modal__body"
    >
      <div className="dm-screen-share-tabs" role="tablist" aria-label="Tipo de compartilhamento">
        <button
          type="button"
          className={`dm-screen-share-tab${activeTab === "window" ? " is-active" : ""}`}
          onClick={() => onTabChange("window")}
        >
          Aplicativos
        </button>
        <button
          type="button"
          className={`dm-screen-share-tab${activeTab === "screen" ? " is-active" : ""}`}
          onClick={() => onTabChange("screen")}
        >
          Tela inteira
        </button>
        <button
          type="button"
          className={`dm-screen-share-tab${activeTab === "device" ? " is-active" : ""}`}
          onClick={() => onTabChange("device")}
        >
          Dispositivos
        </button>
      </div>

      <div className="dm-screen-share-grid">
        {isLoading ? (
          <div className="dm-screen-share-empty">Carregando fontes...</div>
        ) : sources.length === 0 ? (
          <div className="dm-screen-share-empty">Nenhuma fonte disponivel.</div>
        ) : (
          sources.map((source) => {
            const isSelected = selectedSourceId === source.id;
            return (
              <div
                key={source.id}
                role="button"
                tabIndex={0}
                className={`dm-screen-share-tile${isSelected ? " is-selected" : ""}`}
                onClick={() => onSelectSource(source.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectSource(source.id);
                  }
                }}
              >
                <div className="dm-screen-share-tile__thumb">
                  {source.thumbnail ? (
                    <img src={source.thumbnail} alt={source.name} />
                  ) : (
                    <div className="dm-screen-share-tile__thumb-fallback" />
                  )}
                  <button
                    type="button"
                    className="dm-screen-share-tile__share-btn"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectSource(source.id);
                      onConfirm(source.id);
                    }}
                  >
                    <MaterialSymbolIcon name="screen_share" size={16} />
                    Compartilhar
                  </button>
                </div>
                <div className="dm-screen-share-tile__title">
                  {source.appIcon ? <img src={source.appIcon} alt="" aria-hidden="true" /> : null}
                  <span>{source.name}</span>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="dm-screen-share-footer">
        <div className="dm-screen-share-quality">
          <div className="dm-screen-share-quality__field">
            <label htmlFor="dm-screen-share-resolution">Resolucao</label>
            <select
              id="dm-screen-share-resolution"
              value={resolution}
              onChange={(event) => {
                const nextResolution = event.target.value as ResolutionKey;
                const nextFpsOptions = getFpsOptions(nextResolution);
                const nextFps = nextFpsOptions.includes(safeFps) ? safeFps : nextFpsOptions[0];
                onQualityChange(`${nextResolution}${nextFps}`);
              }}
            >
              <option value="480p">480p</option>
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
              <option value="1440p">1440p</option>
              <option value="2160p">2160p</option>
            </select>
          </div>
          <div className="dm-screen-share-quality__field">
            <label htmlFor="dm-screen-share-fps">FPS</label>
            <select
              id="dm-screen-share-fps"
              value={safeFps}
              onChange={(event) => onQualityChange(`${resolution}${event.target.value}`)}
            >
              {availableFps.map((fpsOption) => (
                <option key={fpsOption} value={fpsOption}>
                  {fpsOption} FPS
                </option>
              ))}
            </select>
          </div>
        </div>

      </div>
    </Modal>
  );
}
