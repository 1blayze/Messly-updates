import "../../styles/components/ServerRail.css";
import messagesIcon from "../../assets/icons/ui/Chat.svg";
import { useAppSelector } from "../../stores/store";
import ServerRailItem from "./ServerRailItem";

export default function ServerRail() {
  const unreadCount = useAppSelector((state) => {
    let nextCount = 0;
    for (const conversationId of state.conversations.ids) {
      const conversation = state.conversations.entities[conversationId];
      if (!conversation) {
        continue;
      }
      const unread = Number(conversation.unreadCount ?? 0);
      if (!Number.isFinite(unread) || unread <= 0) {
        continue;
      }
      nextCount += unread;
    }
    return nextCount;
  });

  return (
    <aside className="server-rail">
      <div className="server-rail__top">
        <ServerRailItem
          label="Mensagens diretas"
          iconSrc={messagesIcon}
          isActive
          isHome
          hasUnread={unreadCount > 0}
          hasMention={false}
          unreadCount={unreadCount}
        />
      </div>
    </aside>
  );
}
