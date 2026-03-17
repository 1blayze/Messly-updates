import { useEffect, useMemo, useState } from "react";
import AvatarImage from "../ui/AvatarImage";
import Modal from "../ui/Modal";
import { getAvatarUrl, getNameAvatarUrl, isDefaultAvatarUrl } from "../../services/cdn/mediaUrls";
import { listFriendRequests } from "../../services/friends/friendRequestsApi";
import { supabase } from "../../services/supabase";
import { buildGroupDmName } from "../../services/chat/groupDm";
import "../../styles/components/CreateGroupDmModal.css";

const MAX_GROUP_DM_MEMBERS = 10;
const MAX_GROUP_DM_OTHER_PARTICIPANTS = MAX_GROUP_DM_MEMBERS - 1;
const PROFILE_SELECT_COLUMNS = "id,username,display_name,avatar_url,avatar_key,avatar_hash";

interface GroupDmCandidate {
  userId: string;
  username: string;
  displayName: string;
  avatarSrc: string;
}

interface ProfileRow {
  id: string;
  username?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
  avatar_key?: string | null;
  avatar_hash?: string | null;
}

interface CreateGroupDmModalProps {
  isOpen: boolean;
  currentUserId: string | null | undefined;
  onClose: () => void;
  onCreate: (participantIds: string[], generatedName: string) => Promise<void>;
}

function normalizeCandidateName(displayNameRaw: string | null | undefined, usernameRaw: string | null | undefined): string {
  const displayName = String(displayNameRaw ?? "").trim();
  if (displayName) {
    return displayName;
  }

  const username = String(usernameRaw ?? "").trim();
  if (username) {
    return username;
  }

  return "Usuario";
}

async function resolveCandidateAvatar(profile: ProfileRow, fallbackName: string): Promise<string> {
  const fallbackAvatar = getNameAvatarUrl(fallbackName || "U");
  try {
    const primaryAvatar = await getAvatarUrl(profile.id, profile.avatar_key ?? null, profile.avatar_hash ?? null);
    if (!isDefaultAvatarUrl(primaryAvatar)) {
      return primaryAvatar;
    }

    const legacyAvatarUrl = String(profile.avatar_url ?? "").trim();
    if (!legacyAvatarUrl) {
      return fallbackAvatar;
    }

    const legacyAvatar = await getAvatarUrl(profile.id, legacyAvatarUrl, profile.avatar_hash ?? null);
    return isDefaultAvatarUrl(legacyAvatar) ? fallbackAvatar : legacyAvatar;
  } catch {
    return fallbackAvatar;
  }
}

export default function CreateGroupDmModal({
  isOpen,
  currentUserId,
  onClose,
  onCreate,
}: CreateGroupDmModalProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [candidates, setCandidates] = useState<GroupDmCandidate[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setSearchTerm("");
      setSelectedUserIds([]);
      setCandidates([]);
      setLoadError(null);
      setIsLoadingCandidates(false);
      setIsCreatingGroup(false);
      return;
    }

    const normalizedCurrentUserId = String(currentUserId ?? "").trim();
    if (!normalizedCurrentUserId) {
      setCandidates([]);
      setLoadError("Nao foi possivel identificar sua conta.");
      return;
    }

    let isDisposed = false;
    setIsLoadingCandidates(true);
    setLoadError(null);

    void (async () => {
      try {
        const acceptedRequests = await listFriendRequests("accepted", normalizedCurrentUserId);
        const friendIds = Array.from(
          new Set(
            acceptedRequests
              .map((request) => {
                const requesterId = String(request.requester_id ?? "").trim();
                const addresseeId = String(request.addressee_id ?? "").trim();
                if (requesterId === normalizedCurrentUserId) {
                  return addresseeId;
                }
                if (addresseeId === normalizedCurrentUserId) {
                  return requesterId;
                }
                return "";
              })
              .filter((userId) => Boolean(userId) && userId !== normalizedCurrentUserId),
          ),
        );

        if (friendIds.length === 0) {
          if (!isDisposed) {
            setCandidates([]);
          }
          return;
        }

        const { data, error } = await supabase
          .from("profiles")
          .select(PROFILE_SELECT_COLUMNS)
          .in("id", friendIds);

        if (error) {
          throw error;
        }

        const profiles = (Array.isArray(data) ? data : []) as ProfileRow[];
        const profilesByUserId = new Map<string, ProfileRow>();
        profiles.forEach((profile) => {
          profilesByUserId.set(profile.id, profile);
        });

        const resolvedCandidates = await Promise.all(
          friendIds.map(async (friendId) => {
            const profile = profilesByUserId.get(friendId);
            if (!profile) {
              return null;
            }

            const username = String(profile.username ?? "").trim() || "usuario";
            const displayName = normalizeCandidateName(profile.display_name, username);
            return {
              userId: friendId,
              username,
              displayName,
              avatarSrc: await resolveCandidateAvatar(profile, displayName || username),
            } satisfies GroupDmCandidate;
          }),
        );

        if (isDisposed) {
          return;
        }

        setCandidates(
          resolvedCandidates
            .filter((candidate): candidate is GroupDmCandidate => candidate !== null)
            .sort((left, right) => left.displayName.localeCompare(right.displayName, "pt-BR", { sensitivity: "base" })),
        );
      } catch (error) {
        if (isDisposed) {
          return;
        }
        setCandidates([]);
        setLoadError(error instanceof Error ? error.message : "Nao foi possivel carregar seus amigos.");
      } finally {
        if (!isDisposed) {
          setIsLoadingCandidates(false);
        }
      }
    })();

    return () => {
      isDisposed = true;
    };
  }, [currentUserId, isOpen]);

  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
  const selectedCandidates = useMemo(
    () => selectedUserIds
      .map((userId) => candidates.find((candidate) => candidate.userId === userId) ?? null)
      .filter((candidate): candidate is GroupDmCandidate => candidate !== null),
    [candidates, selectedUserIds],
  );
  const filteredCandidates = useMemo(
    () => candidates.filter((candidate) => {
      if (!normalizedSearchTerm) {
        return true;
      }

      return (
        candidate.displayName.toLowerCase().includes(normalizedSearchTerm) ||
        candidate.username.toLowerCase().includes(normalizedSearchTerm)
      );
    }),
    [candidates, normalizedSearchTerm],
  );
  const hasReachedSelectionLimit = selectedUserIds.length >= MAX_GROUP_DM_OTHER_PARTICIPANTS;
  const remainingFriendSlots = Math.max(0, MAX_GROUP_DM_OTHER_PARTICIPANTS - selectedUserIds.length);

  const handleRequestClose = (): void => {
    if (isCreatingGroup) {
      return;
    }
    onClose();
  };

  const toggleCandidate = (userId: string): void => {
    setSelectedUserIds((current) => {
      if (current.includes(userId)) {
        return current.filter((entry) => entry !== userId);
      }
      if (current.length >= MAX_GROUP_DM_OTHER_PARTICIPANTS) {
        return current;
      }
      return [...current, userId];
    });
  };

  const handleCreateGroup = async (): Promise<void> => {
    if (selectedCandidates.length === 0 || isCreatingGroup) {
      return;
    }

    setIsCreatingGroup(true);
    setLoadError(null);

    try {
      const generatedName = buildGroupDmName(selectedCandidates.map((candidate) => candidate.displayName));
      await onCreate(selectedCandidates.map((candidate) => candidate.userId), generatedName);
      onClose();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Nao foi possivel criar o grupo privado.");
    } finally {
      setIsCreatingGroup(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title="Criar novo grupo privado"
      ariaLabel="Criar novo grupo privado"
      onClose={handleRequestClose}
      panelClassName="create-group-dm-modal"
      bodyClassName="create-group-dm-modal__body"
      footer={(
        <div className="create-group-dm-modal__footer">
          <button
            className="create-group-dm-modal__button create-group-dm-modal__button--secondary"
            type="button"
            onClick={handleRequestClose}
            disabled={isCreatingGroup}
          >
            Cancelar
          </button>
          <button
            className="create-group-dm-modal__button create-group-dm-modal__button--primary"
            type="button"
            onClick={() => {
              void handleCreateGroup();
            }}
            disabled={selectedUserIds.length === 0 || isCreatingGroup}
          >
            {isCreatingGroup ? "Criando..." : "Criar grupo privado"}
          </button>
        </div>
      )}
    >
      <div className="create-group-dm-modal__content">
        <p className="create-group-dm-modal__subtitle">
          Voce pode adicionar mais {remainingFriendSlots} {remainingFriendSlots === 1 ? "amigo" : "amigos"}.
        </p>

        <label className="create-group-dm-modal__search-wrap" htmlFor="create-group-dm-search">
          <input
            id="create-group-dm-search"
            className="create-group-dm-modal__search"
            type="text"
            value={searchTerm}
            onChange={(event) => {
              setSearchTerm(event.target.value);
            }}
            placeholder="Buscar amigos"
            autoComplete="off"
            spellCheck={false}
            disabled={isLoadingCandidates || isCreatingGroup}
          />
        </label>

        {hasReachedSelectionLimit ? (
          <p className="create-group-dm-modal__limit-note">
            Voce atingiu o limite maximo de 10 pessoas no grupo.
          </p>
        ) : null}

        {loadError ? (
          <p className="create-group-dm-modal__feedback create-group-dm-modal__feedback--error">{loadError}</p>
        ) : null}

        <div className="create-group-dm-modal__list" role="list" aria-label="Lista de usuarios para adicionar ao grupo">
          {isLoadingCandidates ? (
            <p className="create-group-dm-modal__empty">Carregando amigos...</p>
          ) : null}

          {!isLoadingCandidates && filteredCandidates.length === 0 ? (
            <p className="create-group-dm-modal__empty">
              {candidates.length === 0 ? "Voce ainda nao tem amigos para adicionar." : "Nenhum usuario encontrado."}
            </p>
          ) : null}

          {!isLoadingCandidates ? filteredCandidates.map((candidate) => {
            const isSelected = selectedUserIds.includes(candidate.userId);
            const isDisabled = !isSelected && hasReachedSelectionLimit;
            return (
              <button
                key={candidate.userId}
                className={`create-group-dm-modal__user${isSelected ? " create-group-dm-modal__user--selected" : ""}`}
                type="button"
                role="listitem"
                onClick={() => {
                  toggleCandidate(candidate.userId);
                }}
                disabled={isDisabled || isCreatingGroup}
              >
                <AvatarImage
                  className="create-group-dm-modal__user-avatar"
                  src={candidate.avatarSrc}
                  name={candidate.displayName || candidate.username}
                  alt={`Avatar de ${candidate.displayName}`}
                  loading="lazy"
                />
                <div className="create-group-dm-modal__user-meta">
                  <span className="create-group-dm-modal__user-name">{candidate.displayName}</span>
                  <span className="create-group-dm-modal__user-username">{candidate.username}</span>
                </div>
                <span
                  className={`create-group-dm-modal__user-check${isSelected ? " create-group-dm-modal__user-check--selected" : ""}`}
                  aria-hidden="true"
                >
                  <span className="create-group-dm-modal__user-check-icon" />
                </span>
              </button>
            );
          }) : null}
        </div>
      </div>
    </Modal>
  );
}
