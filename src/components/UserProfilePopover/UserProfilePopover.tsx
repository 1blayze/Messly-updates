import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import EmojiButton from "../chat/EmojiButton";
import { getNameAvatarUrl, isDefaultBannerUrl } from "../../services/cdn/mediaUrls";
import type { PresenceState } from "../../services/presence/presenceTypes";
import { normalizeBannerColor } from "../../services/profile/bannerColor";
import messageIconSrc from "../../assets/images/msg.png";
import styles from "./UserProfilePopover.module.css";

interface UserProfilePopoverProps {
  avatarSrc: string;
  bannerSrc?: string;
  bannerColor?: string | null;
  displayName: string;
  username: string;
  presenceLabel: string;
  presenceState: PresenceState;
  showActions?: boolean;
  viewMode?: "compact" | "full";
  showMessageComposer?: boolean;
  showEditProfileButton?: boolean;
  memberSinceLabel?: string;
  onCloseFullProfile?: () => void;
  messageComposerInputRef?: RefObject<HTMLInputElement>;
  messageComposerValue?: string;
  onMessageComposerChange?: (nextValue: string) => void;
  onMessageComposerSubmit?: () => void;
  messageComposerEmojiButtonRef?: RefObject<HTMLButtonElement>;
  messageComposerEmojiDisabled?: boolean;
  isMessageComposerEmojiOpen?: boolean;
  onToggleMessageComposerEmoji?: () => void;
  aboutText?: string;
  onChangePresence?: (state: PresenceState) => void;
  onEditProfile?: () => void;
  showFriendActions?: boolean;
  onUnfriend?: () => void | Promise<void>;
  isUnfriending?: boolean;
  showFriendRequestPending?: boolean;
  showAddFriendAction?: boolean;
  onAddFriend?: () => void | Promise<void>;
  isAddingFriend?: boolean;
  showBlockAction?: boolean;
  onBlockUser?: () => void | Promise<void>;
  isBlockingUser?: boolean;
  onOpenFullProfile?: () => void;
}

const BADGE_BY_STATE: Record<PresenceState, string> = {
  online: styles.presenceOnline,
  idle: styles.presenceIdle,
  dnd: styles.presenceDnd,
  offline: styles.presenceOffline,
};

type FullProfileTab = "activity" | "mutualFriends";

export default function UserProfilePopover({
  avatarSrc,
  bannerSrc,
  bannerColor,
  displayName,
  username,
  presenceLabel,
  presenceState,
  showActions = true,
  viewMode = "compact",
  showMessageComposer = false,
  showEditProfileButton = false,
  memberSinceLabel = "Data nao disponivel",
  onCloseFullProfile,
  messageComposerInputRef,
  messageComposerValue = "",
  onMessageComposerChange,
  onMessageComposerSubmit,
  messageComposerEmojiButtonRef,
  messageComposerEmojiDisabled = false,
  isMessageComposerEmojiOpen = false,
  onToggleMessageComposerEmoji,
  aboutText,
  onChangePresence,
  onEditProfile,
  showFriendActions = false,
  onUnfriend,
  isUnfriending = false,
  showFriendRequestPending = false,
  showAddFriendAction = false,
  onAddFriend,
  isAddingFriend = false,
  showBlockAction = false,
  onBlockUser,
  isBlockingUser = false,
  onOpenFullProfile,
}: UserProfilePopoverProps) {
  const closeTimerRef = useRef<number | null>(null);
  const aboutTextRef = useRef<HTMLParagraphElement | null>(null);
  const fullAboutTextRef = useRef<HTMLParagraphElement | null>(null);
  const friendMenuRef = useRef<HTMLDivElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const [isPresenceMenuOpen, setIsPresenceMenuOpen] = useState(false);
  const [canShowFullBioHint, setCanShowFullBioHint] = useState(false);
  const [isFullBioExpanded, setIsFullBioExpanded] = useState(false);
  const [canToggleFullBio, setCanToggleFullBio] = useState(false);
  const [activeFullProfileTab, setActiveFullProfileTab] = useState<FullProfileTab>("activity");
  const [isFriendMenuOpen, setIsFriendMenuOpen] = useState(false);
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const badgeClass = BADGE_BY_STATE[presenceState];
  const safeAboutText = aboutText?.trim() ?? "";
  const canOpenFullProfile = viewMode !== "full" && typeof onOpenFullProfile === "function";
  const safeMessageComposerValue = showMessageComposer ? messageComposerValue : "";
  const fallbackAvatarSrc = useMemo(
    () => getNameAvatarUrl(displayName.trim() || username.trim() || "U"),
    [displayName, username],
  );
  const safeAvatarSrc = useMemo(() => {
    const trimmed = avatarSrc.trim();
    const isAbsolute =
      trimmed.startsWith("http://") ||
      trimmed.startsWith("https://") ||
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:");
    return !trimmed || !isAbsolute ? fallbackAvatarSrc : trimmed;
  }, [avatarSrc, fallbackAvatarSrc]);
  const safeBannerSrc = useMemo(() => {
    const trimmed = (bannerSrc ?? "").trim();
    const isAbsolute =
      trimmed.startsWith("http://") ||
      trimmed.startsWith("https://") ||
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:");
    return !trimmed || !isAbsolute || isDefaultBannerUrl(trimmed) ? "" : trimmed;
  }, [bannerSrc]);
  const safeBannerColor = useMemo(() => normalizeBannerColor(bannerColor), [bannerColor]);
  const bannerInlineStyle = useMemo<CSSProperties | undefined>(() => {
    // When a custom banner image exists, do not apply the fallback stripe color.
    if (safeBannerSrc || !safeBannerColor) {
      return undefined;
    }
    return {
      background: safeBannerColor,
    };
  }, [safeBannerColor, safeBannerSrc]);

  const PRESENCE_OPTIONS: Array<{
    state: PresenceState;
    label: string;
    description?: string;
  }> = [
    {
      state: "online",
      label: "Disponivel",
    },
    {
      state: "idle",
      label: "Ausente",
    },
    {
      state: "dnd",
      label: "Nao perturbar",
      description: "Voce nao recebera notificacao na area de trabalho",
    },
    {
      state: "offline",
      label: "Offline",
      description: "Voce vai aparecer offline para outros usuarios",
    },
  ];

  const clearPresenceCloseTimer = (): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const openPresenceMenu = (): void => {
    clearPresenceCloseTimer();
    setIsPresenceMenuOpen(true);
  };

  const schedulePresenceMenuClose = (): void => {
    clearPresenceCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setIsPresenceMenuOpen(false);
    }, 120);
  };

  const handlePresenceSelect = (state: PresenceState): void => {
    onChangePresence?.(state);
    setIsPresenceMenuOpen(false);
  };

  const handlePresenceBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const relatedTarget = event.relatedTarget;
    if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) {
      schedulePresenceMenuClose();
    }
  };

  useEffect(() => {
    return () => {
      clearPresenceCloseTimer();
    };
  }, []);

  useEffect(() => {
    if (!safeAboutText) {
      setCanShowFullBioHint(false);
      return;
    }

    let frameId = 0;
    const checkAboutOverflow = (): void => {
      const element = aboutTextRef.current;
      if (!element) {
        setCanShowFullBioHint(false);
        return;
      }
      setCanShowFullBioHint(element.scrollHeight - element.clientHeight > 1);
    };

    frameId = window.requestAnimationFrame(checkAboutOverflow);
    window.addEventListener("resize", checkAboutOverflow);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", checkAboutOverflow);
    };
  }, [safeAboutText]);

  useEffect(() => {
    setIsFullBioExpanded(false);
  }, [safeAboutText, viewMode]);

  useEffect(() => {
    if (viewMode !== "full" || !safeAboutText) {
      setCanToggleFullBio(false);
      return;
    }

    let frameId = 0;
    const checkFullAboutOverflow = (): void => {
      const element = fullAboutTextRef.current;
      if (!element) {
        setCanToggleFullBio(false);
        return;
      }

      if (isFullBioExpanded) {
        setCanToggleFullBio(true);
        return;
      }

      setCanToggleFullBio(element.scrollHeight - element.clientHeight > 1);
    };

    frameId = window.requestAnimationFrame(checkFullAboutOverflow);
    window.addEventListener("resize", checkFullAboutOverflow);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", checkFullAboutOverflow);
    };
  }, [isFullBioExpanded, safeAboutText, viewMode]);

  useEffect(() => {
    if (viewMode === "full") {
      setActiveFullProfileTab("activity");
    }
  }, [username, viewMode]);

  useEffect(() => {
    if (!isFriendMenuOpen && !isMoreMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      const isInsideFriendMenu = Boolean(friendMenuRef.current?.contains(target));
      const isInsideMoreMenu = Boolean(moreMenuRef.current?.contains(target));
      if (!isInsideFriendMenu && !isInsideMoreMenu) {
        setIsFriendMenuOpen(false);
        setIsMoreMenuOpen(false);
      }
    };

    const handleEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsFriendMenuOpen(false);
        setIsMoreMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isFriendMenuOpen, isMoreMenuOpen]);

  const handleMessageComposerChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onMessageComposerChange?.(event.target.value);
  };

  const handleMessageComposerKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    onMessageComposerSubmit?.();
  };

  const handleFullPrimaryAction = (): void => {
    if (showEditProfileButton) {
      onEditProfile?.();
      return;
    }
    onMessageComposerSubmit?.();
  };

  const handleUnfriendClick = (): void => {
    if (isUnfriending) {
      return;
    }
    setIsFriendMenuOpen(false);
    void onUnfriend?.();
  };

  const handleAddFriendClick = (): void => {
    if (isAddingFriend) {
      return;
    }
    setIsFriendMenuOpen(false);
    void onAddFriend?.();
  };

  const handleBlockUserClick = (): void => {
    if (isBlockingUser) {
      return;
    }
    setIsMoreMenuOpen(false);
    void onBlockUser?.();
  };

  const isFriendMenuMode = showFriendActions;
  const isFriendRequestPendingMode = !isFriendMenuMode && showFriendRequestPending;
  const isAddFriendMode = !isFriendMenuMode && !isFriendRequestPendingMode && showAddFriendAction;

  if (viewMode === "full") {
    return (
      <article className={`${styles.panel} ${styles.panelFull}`} role="dialog" aria-label="Perfil completo do usuario">
        <div className={styles.fullLayout}>
          <section className={`${styles.fullSidebar}${showEditProfileButton ? ` ${styles.fullSidebarOwn}` : ""}`}>
            <header className={styles.fullHeader}>
              <div className={styles.fullBanner} style={bannerInlineStyle}>
                {safeBannerSrc ? (
                  <img
                    key={safeBannerSrc}
                    className={styles.fullBannerImage}
                    src={safeBannerSrc}
                    alt=""
                    loading="lazy"
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                ) : null}
              </div>

              <div className={styles.fullAvatarWrap}>
                <img
                  className={styles.fullAvatar}
                  src={safeAvatarSrc}
                  alt={`Avatar de ${displayName}`}
                  onError={(event) => {
                    const target = event.currentTarget;
                    if (target.src !== fallbackAvatarSrc) {
                      target.src = fallbackAvatarSrc;
                    }
                  }}
                />
                <span className={`${styles.fullPresenceBadge} ${badgeClass}`} aria-hidden="true" />
              </div>
            </header>

            <div className={styles.fullSidebarBody}>
              <section className={styles.fullIdentity}>
                <h3 className={styles.fullDisplayName}>{displayName}</h3>
                <p className={styles.fullUsername}>{username}</p>
              </section>

              <div className={styles.fullPrimaryActions}>
                <button className={styles.fullPrimaryButton} type="button" onClick={handleFullPrimaryAction}>
                  {showEditProfileButton ? (
                    <MaterialSymbolIcon name="edit" size={16} filled={false} />
                  ) : (
                    <img className={styles.fullPrimaryButtonImageIcon} src={messageIconSrc} alt="" aria-hidden="true" />
                  )}
                  {showEditProfileButton ? "Editar perfil" : "Mensagem"}
                </button>

                <div className={styles.fullFriendMenuWrap} ref={friendMenuRef}>
                  <button
                    className={`${styles.fullSecondaryActionButton}${
                      isFriendRequestPendingMode ? ` ${styles.fullSecondaryActionButtonDisabled}` : ""
                    }`}
                    type="button"
                    aria-label={
                      isFriendRequestPendingMode
                        ? "Pedido enviado"
                        : isFriendMenuMode
                          ? "Amizade"
                          : isAddFriendMode
                            ? "Adicionar amigo"
                            : "Amizade"
                    }
                    title={isFriendRequestPendingMode ? "Pedido enviado" : undefined}
                    aria-haspopup={isFriendMenuMode ? "menu" : undefined}
                    aria-expanded={isFriendMenuMode ? isFriendMenuOpen : undefined}
                    aria-disabled={isFriendRequestPendingMode ? true : undefined}
                    disabled={isAddFriendMode ? isAddingFriend : false}
                    onClick={() => {
                      if (isFriendMenuMode) {
                        setIsMoreMenuOpen(false);
                        setIsFriendMenuOpen((current) => !current);
                        return;
                      }

                      if (isFriendRequestPendingMode) {
                        return;
                      }

                      if (isAddFriendMode) {
                        setIsMoreMenuOpen(false);
                        handleAddFriendClick();
                        return;
                      }

                      if (!isFriendMenuMode && !isAddFriendMode) {
                        return;
                      }
                    }}
                  >
                    {isFriendRequestPendingMode ? (
                      <span className={styles.fullSecondaryActionPendingIcon} aria-hidden="true">
                        <MaterialSymbolIcon
                          className={styles.fullSecondaryActionPendingPerson}
                          name="person"
                          size={16}
                          filled
                        />
                        <span className={styles.fullSecondaryActionPendingClock} />
                      </span>
                    ) : isAddFriendMode ? (
                      <MaterialSymbolIcon name="person_add" size={16} filled={false} />
                    ) : (
                      <MaterialSymbolIcon name="person" size={16} filled />
                    )}
                  </button>

                  {isFriendMenuMode && isFriendMenuOpen ? (
                    <div className={styles.fullFriendMenu} role="menu" aria-label="Acoes de amizade">
                      <button
                        className={styles.fullFriendMenuItem}
                        type="button"
                        role="menuitem"
                        onClick={handleUnfriendClick}
                        disabled={isUnfriending}
                      >
                        {isUnfriending ? "Desfazendo..." : "Desfazer amizade"}
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className={styles.fullMoreMenuWrap} ref={moreMenuRef}>
                  <button
                    className={styles.fullSecondaryActionButton}
                    type="button"
                    aria-label="Mais opcoes"
                    aria-haspopup={showBlockAction ? "menu" : undefined}
                    aria-expanded={showBlockAction ? isMoreMenuOpen : undefined}
                    onClick={() => {
                      if (!showBlockAction) {
                        return;
                      }
                      setIsFriendMenuOpen(false);
                      setIsMoreMenuOpen((current) => !current);
                    }}
                  >
                    <MaterialSymbolIcon name="more_horiz" size={16} filled={false} />
                  </button>

                  {showBlockAction && isMoreMenuOpen ? (
                    <div className={styles.fullMoreMenu} role="menu" aria-label="Mais acoes">
                      <button
                        className={`${styles.fullMoreMenuItem} ${styles.fullMoreMenuItemDanger}`}
                        type="button"
                        role="menuitem"
                        onClick={handleBlockUserClick}
                        disabled={isBlockingUser}
                      >
                        {isBlockingUser ? "Bloqueando..." : "Bloquear usuario"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              <section className={styles.fullDetails}>
                {safeAboutText ? (
                  <div className={styles.fullDetailSection}>
                    <p
                      ref={fullAboutTextRef}
                      className={`${styles.fullBioPlain}${isFullBioExpanded ? ` ${styles.fullBioExpanded}` : ""}`}
                    >
                      {safeAboutText}
                    </p>
                    {canToggleFullBio ? (
                      <button
                        className={styles.fullBioToggle}
                        type="button"
                        onClick={() => setIsFullBioExpanded((current) => !current)}
                      >
                        {isFullBioExpanded ? "Ver menos" : "Ver mais"}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                <div className={styles.fullDetailSection}>
                  <p className={styles.fullDetailTitle}>Membro desde</p>
                  <p className={styles.fullDetailValue}>{memberSinceLabel}</p>
                </div>
              </section>
            </div>
          </section>

          <section className={styles.fullContent}>
            <nav className={styles.fullTabs} aria-label="Abas do perfil" role="tablist">
              <button
                className={`${styles.fullTabButton}${activeFullProfileTab === "activity" ? ` ${styles.fullTabButtonActive}` : ""}`}
                type="button"
                role="tab"
                aria-selected={activeFullProfileTab === "activity"}
                onClick={() => setActiveFullProfileTab("activity")}
              >
                Atividade
              </button>
              <button
                className={`${styles.fullTabButton}${activeFullProfileTab === "mutualFriends" ? ` ${styles.fullTabButtonActive}` : ""}`}
                type="button"
                role="tab"
                aria-selected={activeFullProfileTab === "mutualFriends"}
                onClick={() => setActiveFullProfileTab("mutualFriends")}
              >
                Amigos em comum
              </button>
            </nav>

            <div className={styles.fullContentBody}>
              {activeFullProfileTab === "activity" ? (
                <section className={styles.fullActivitySection}>
                  <h4 className={styles.fullActivityTitle}>Atividade recente</h4>
                </section>
              ) : (
                <section className={styles.fullPlaceholderSection}>
                  <h4 className={styles.fullPlaceholderTitle}>Amigos em comum</h4>
                  <p className={styles.fullPlaceholderText}>
                    Voce e {displayName} ainda nao tem amigos em comum. Quando houver conexoes em comum, elas aparecerao aqui.
                  </p>
                </section>
              )}
            </div>
          </section>
        </div>
      </article>
    );
  }

  return (
    <article
      className={`${styles.panel}${!showActions ? ` ${styles.panelNoActions}` : ""}`}
      role="dialog"
      aria-label="Perfil do usuario"
    >
      <header className={styles.header}>
        <div className={styles.banner} style={bannerInlineStyle}>
          {safeBannerSrc ? (
            <img
              key={safeBannerSrc}
              className={styles.bannerImage}
              src={safeBannerSrc}
              alt=""
              loading="lazy"
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
          ) : null}
        </div>
        {canOpenFullProfile ? (
          <button
            className={`${styles.avatarWrap} ${styles.avatarWrapButton}`}
            type="button"
            onClick={onOpenFullProfile}
            aria-label={`Abrir perfil completo de ${displayName}`}
          >
            <img
              className={styles.avatar}
              src={safeAvatarSrc}
              alt={`Avatar de ${displayName}`}
              onError={(event) => {
                const target = event.currentTarget;
                if (target.src !== fallbackAvatarSrc) {
                  target.src = fallbackAvatarSrc;
                }
              }}
            />
            <span className={`${styles.presenceBadge} ${badgeClass}`} aria-hidden="true" />
          </button>
        ) : (
          <div className={styles.avatarWrap}>
            <img
              className={styles.avatar}
              src={safeAvatarSrc}
              alt={`Avatar de ${displayName}`}
              onError={(event) => {
                const target = event.currentTarget;
                if (target.src !== fallbackAvatarSrc) {
                  target.src = fallbackAvatarSrc;
                }
              }}
            />
            <span className={`${styles.presenceBadge} ${badgeClass}`} aria-hidden="true" />
          </div>
        )}
      </header>

      <section className={styles.body}>
        <div className={styles.identity}>
          {canOpenFullProfile ? (
            <h3 className={styles.displayNameHeading}>
              <button
                className={`${styles.displayName} ${styles.displayNameButton}`}
                type="button"
                onClick={onOpenFullProfile}
                aria-label={`Abrir perfil completo de ${displayName}`}
              >
                {displayName}
              </button>
            </h3>
          ) : (
            <h3 className={styles.displayName}>{displayName}</h3>
          )}
          <p className={styles.username}>@{username}</p>
          {safeAboutText ? (
            <div className={styles.aboutWrap}>
              <p ref={aboutTextRef} className={styles.about}>
                {safeAboutText}
              </p>
              {canShowFullBioHint ? (
                canOpenFullProfile ? (
                  <button
                    className={`${styles.aboutHint} ${styles.aboutHintButton}`}
                    type="button"
                    onClick={onOpenFullProfile}
                  >
                    Ver Biografia Completa
                  </button>
                ) : (
                  <span className={styles.aboutHint}>Ver Biografia Completa</span>
                )
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {showMessageComposer ? (
        <div className={styles.messageComposer}>
          <input
            ref={messageComposerInputRef}
            className={styles.messageComposerInput}
            type="text"
            value={safeMessageComposerValue}
            onChange={handleMessageComposerChange}
            onKeyDown={handleMessageComposerKeyDown}
            placeholder={`Conversar com @${username}`}
            autoComplete="off"
            aria-label={`Conversar com @${username}`}
          />
          {messageComposerEmojiButtonRef && onToggleMessageComposerEmoji ? (
            <EmojiButton
              buttonRef={messageComposerEmojiButtonRef}
              isOpen={isMessageComposerEmojiOpen}
              disabled={messageComposerEmojiDisabled}
              onToggle={onToggleMessageComposerEmoji}
            />
          ) : (
            <button className={styles.messageComposerIconButton} type="button" aria-label="Abrir emojis" disabled>
              <MaterialSymbolIcon name="sentiment_satisfied" size={18} filled={false} />
            </button>
          )}
        </div>
      ) : showEditProfileButton ? (
        <div className={styles.messageComposerEditWrap}>
          <button className={styles.messageComposerEditButton} type="button" onClick={onEditProfile}>
            <span className={styles.messageComposerEditButtonContent}>
              <MaterialSymbolIcon name="edit" size={16} filled={false} />
              Editar perfil
            </span>
          </button>
        </div>
      ) : null}

      {showActions ? (
        <div className={styles.actions}>
          <button className={styles.actionButton} type="button" onClick={onEditProfile}>
            <span className={styles.actionLeft}>
              <MaterialSymbolIcon name="edit" size={18} filled={false} />
              Editar perfil
            </span>
          </button>

          <div
            className={styles.presenceActionWrap}
            onMouseEnter={openPresenceMenu}
            onMouseLeave={schedulePresenceMenuClose}
            onFocusCapture={openPresenceMenu}
            onBlurCapture={handlePresenceBlur}
          >
            <button
              className={`${styles.actionButton}${isPresenceMenuOpen ? ` ${styles.actionButtonActive}` : ""}`}
              type="button"
              onClick={() => setIsPresenceMenuOpen((current) => !current)}
              aria-expanded={isPresenceMenuOpen}
              aria-haspopup="menu"
            >
              <span className={styles.actionLeft}>
                <span className={`${styles.presenceMenuDot} ${badgeClass}`} aria-hidden="true" />
                {presenceLabel}
              </span>
            </button>

            {isPresenceMenuOpen ? (
              <div className={styles.presenceMenu} role="menu" aria-label="Selecionar presenca">
                {PRESENCE_OPTIONS.map((option) => {
                  const optionBadgeClass = BADGE_BY_STATE[option.state];
                  const isActive = option.state === presenceState;
                  const dotOffsetClass = option.description ? styles.presenceMenuDotLower : "";

                  return (
                    <button
                      key={option.state}
                      className={`${styles.presenceMenuItem}${isActive ? ` ${styles.presenceMenuItemActive}` : ""}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      onClick={() => handlePresenceSelect(option.state)}
                    >
                      <span className={styles.presenceMenuMain}>
                        <span className={`${styles.presenceMenuDot} ${optionBadgeClass} ${dotOffsetClass}`} aria-hidden="true" />
                        <span className={styles.presenceMenuText}>
                          <span className={styles.presenceMenuLabel}>{option.label}</span>
                          {option.description ? (
                            <span className={styles.presenceMenuDescription}>{option.description}</span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <button className={styles.actionButton} type="button">
            <span className={styles.actionLeft}>
              <MaterialSymbolIcon name="supervisor_account" size={18} filled={false} />
              Mudar de conta
            </span>
          </button>
        </div>
      ) : null}
    </article>
  );
}
