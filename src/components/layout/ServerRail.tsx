import "../../styles/components/ServerRail.css";
import messagesIcon from "../../assets/images/msg.png";

export default function ServerRail() {
  return (
    <aside className="server-rail">
      <div className="server-rail__top">
        <button
          className="server-rail__messages-button server-rail__messages-button--active"
          type="button"
          aria-label="Mensagens"
        >
          <img className="server-rail__messages-image" src={messagesIcon} alt="" aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
