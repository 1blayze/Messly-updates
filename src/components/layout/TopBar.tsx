import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import chatIconSrc from "../../assets/icons/ui/Chat.svg";
import "../../styles/components/TopBar.css";

interface TopBarProps {
  section?: "friends" | "directMessages";
  isCallActive?: boolean;
  onPrepareForUpdateInstall?: () => Promise<void> | void;
}

function getSectionIconName(section: TopBarProps["section"]): string {
  switch (section) {
    case "directMessages":
      return "chat";
    case "friends":
    default:
      return "group";
  }
}

function getSectionLabel(section: TopBarProps["section"]): string {
  switch (section) {
    case "directMessages":
      return "Mensagens diretas";
    case "friends":
    default:
      return "Amigos";
  }
}

export default function TopBar({ section = "friends", isCallActive = false, onPrepareForUpdateInstall }: TopBarProps) {
  void isCallActive;
  void onPrepareForUpdateInstall;
  const isDesktopRuntime = typeof window !== "undefined" && Boolean(window.electronAPI);

  return (
    <header className={`app-top-bar${isDesktopRuntime ? " app-top-bar--desktop" : ""}`}>
      <div className="app-top-bar__context" aria-label={`Secao atual: ${getSectionLabel(section)}`}>
        {section === "directMessages" ? (
          <img className="app-top-bar__context-icon app-top-bar__context-icon--chat" src={chatIconSrc} alt="" aria-hidden="true" />
        ) : (
          <MaterialSymbolIcon
            className="app-top-bar__context-icon"
            name={getSectionIconName(section)}
            size={18}
            filled
          />
        )}
        <span className="app-top-bar__context-text">{getSectionLabel(section)}</span>
      </div>
      <div className="app-top-bar__drag-region" aria-hidden="true" />
    </header>
  );
}
