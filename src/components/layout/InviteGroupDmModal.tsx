import { useEffect, useMemo, useRef, useState } from "react";
import AvatarImage from "../ui/AvatarImage";
import Modal from "../ui/Modal";
import { getAvatarUrl, getNameAvatarUrl, isDefaultAvatarUrl } from "../../services/cdn/mediaUrls";
import { supabase } from "../../services/supabase";
import { useAppSelector } from "../../stores/store";
import "../../styles/components/CreateGroupDmModal.css";

const PROFILE_SELECT_COLUMNS = "id,username,display_name,avatar_url,avatar_key,avatar_hash";
const FRIEND_CANDIDATES_LOAD_TIMEOUT_MS = 7_000;

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

interface InviteGroupDmModalProps {
  isOpen: boolean;
  currentUserId: string | null | undefined;
  existingParticipantIds: string[];
  onClose: () => void;
  onInvite: (participantIds: string[]) => Promise<void>;
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

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export default function InviteGroupDmModal({
  isOpen,
  currentUserId,
  existingParticipantIds,
  onClose,
  onInvite,
}: InviteGroupDmModalProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [candidates, setCandidates] = useState<GroupDmCandidate[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false);
  const [isInviting, setIsInviting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const friendRelationships = useAppSelector((state) => state.friends.relationships);
  const friendRelationshipsRef = useRef(friendRelationships);
  const cachedProfileEntities = useAppSelector((state) => state.profiles.entities);
  const cachedProfileEntitiesRef = useRef(cachedProfileEntities);
  const existingParticipantIdsRef = useRef<string[]>(existingParticipantIds);
  const loadCandidatesRequestIdRef = useRef(0);

  useEffect(() => {
    friendRelationshipsRef.current = friendRelationships;
  }, [friendRelationships]);

  useEffect(() => {
    cachedProfileEntitiesRef.current = cachedProfileEntities;
  }, [cachedProfileEntities]);

  useEffect(() => {
    existingParticipantIdsRef.current = existingParticipantIds;
  }, [existingParticipantIds]);

  useEffect(() => {
    if (!isOpen) {
      loadCandidatesRequestIdRef.current += 1;
      setSearchTerm("");
      setSelectedUserIds([]);
      setCandidates([]);
      setLoadError(null);
      setIsLoadingCandidates(false);
      setIsInviting(false);
      return;
    }

    const normalizedCurrentUserId = String(currentUserId ?? "").trim();
    if (!normalizedCurrentUserId) {
      setCandidates([]);
      setLoadError("Nao foi possivel identificar sua conta.");
      return;
    }

    const excludedUserIdSet = new Set(
      [normalizedCurrentUserId, ...existingParticipantIdsRef.current]
        .map((userId) => String(userId ?? "").trim())
        .filter(Boolean),
    );

    const requestId = loadCandidatesRequestIdRef.current + 1;
    loadCandidatesRequestIdRef.current = requestId;
    setIsLoadingCandidates(true);
    setLoadError(null);

    void (async () => {
      try {
        const friendIds = Object.keys(friendRelationshipsRef.current)
          .map((userId) => String(userId ?? "").trim())
          .filter((userId) => Boolean(userId) && !excludedUserIdSet.has(userId))
          .sort();

        if (friendIds.length === 0) {
          if (loadCandidatesRequestIdRef.current === requestId) {
            setCandidates([]);
          }
          return;
        }

        const profilesByUserId = new Map<string, ProfileRow>();
        const profileEntitiesSnapshot = cachedProfileEntitiesRef.current;
        friendIds.forEach((friendId) => {
          const cachedProfile = profileEntitiesSnapshot[friendId];
          if (!cachedProfile) {
            return;
          }
          profilesByUserId.set(friendId, {
            id: cachedProfile.id,
            username: cachedProfile.username,
            display_name: cachedProfile.displayName,
            avatar_url: cachedProfile.avatarUrl,
            avatar_key: null,
            avatar_hash: null,
          });
        });

        const missingProfileIds = friendIds.filter((friendId) => !profilesByUserId.has(friendId));
        if (missingProfileIds.length > 0) {
          const profilesResponse = await withTimeout<{
            data: ProfileRow[] | null;
            error: { message?: string } | null;
          }>(
            supabase
              .from("profiles")
              .select(PROFILE_SELECT_COLUMNS)
              .in("id", missingProfileIds),
            FRIEND_CANDIDATES_LOAD_TIMEOUT_MS,
            "Tempo limite ao carregar perfis dos amigos.",
          );
          if (profilesResponse.error) {
            throw profilesResponse.error;
          }

          (Array.isArray(profilesResponse.data) ? profilesResponse.data : []).forEach((profile) => {
            profilesByUserId.set(profile.id, profile);
          });
        }

        const resolvedCandidates = await Promise.all(
          friendIds.map(async (friendId) => {
            const profile = profilesByUserId.get(friendId);
            const username = String(profile?.username ?? "").trim() || `usuario_${friendId.slice(0, 4)}`;
            const displayName = normalizeCandidateName(profile?.display_name, username);
            const fallbackAvatar = getNameAvatarUrl(displayName || username);
            return {
              userId: friendId,
              username,
              displayName,
              avatarSrc: profile
                ? await resolveCandidateAvatar(profile, displayName || username)
                : fallbackAvatar,
            } satisfies GroupDmCandidate;
          }),
        );

        if (loadCandidatesRequestIdRef.current !== requestId) {
          return;
        }

        setCandidates(
          resolvedCandidates.sort((left, right) => left.displayName.localeCompare(right.displayName, "pt-BR", { sensitivity: "base" })),
        );
      } catch (error) {
        if (loadCandidatesRequestIdRef.current !== requestId) {
          return;
        }
        setCandidates([]);
        setLoadError(error instanceof Error ? error.message : "Nao foi possivel carregar seus amigos.");
      } finally {
        if (loadCandidatesRequestIdRef.current === requestId) {
          setIsLoadingCandidates(false);
        }
      }
    })();
  }, [currentUserId, isOpen]);

  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
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

  const handleRequestClose = (): void => {
    if (isInviting) {
      return;
    }
    onClose();
  };

  const toggleCandidate = (userId: string): void => {
    setSelectedUserIds((current) => (
      current.includes(userId)
        ? current.filter((entry) => entry !== userId)
        : [...current, userId]
    ));
  };

  const handleInvite = async (): Promise<void> => {
    if (selectedUserIds.length === 0 || isInviting) {
      return;
    }

    setIsInviting(true);
    setLoadError(null);

    try {
      await onInvite(selectedUserIds);
      onClose();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Nao foi possivel enviar os convites.");
    } finally {
      setIsInviting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title="Convidar para grupo"
      ariaLabel="Convidar amigos para o grupo"
      onClose={handleRequestClose}
      panelClassName="create-group-dm-modal"
      bodyClassName="create-group-dm-modal__body"
      footer={(
        <div className="create-group-dm-modal__footer">
          <button
            className="create-group-dm-modal__secondary-btn"
            type="button"
            onClick={handleRequestClose}
            disabled={isInviting}
          >
            Cancelar
          </button>
          <button
            className="create-group-dm-modal__primary-btn"
            type="button"
            onClick={() => {
              void handleInvite();
            }}
            disabled={selectedUserIds.length === 0 || isInviting}
          >
            {isInviting ? "Convidando..." : "Convidar"}
          </button>
        </div>
      )}
    >
      <div className="create-group-dm-modal">
        <p className="create-group-dm-modal__description">
          Selecione amigos para adicionar ao grupo.
        </p>

        <label className="create-group-dm-modal__search-wrap" htmlFor="invite-group-dm-search">
          <input
            id="invite-group-dm-search"
            className="create-group-dm-modal__search"
            type="text"
            placeholder="Buscar amigos"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            autoComplete="off"
            disabled={isInviting}
          />
        </label>

        <div className="create-group-dm-modal__list" role="list" aria-label="Amigos disponiveis para convite">
          {isLoadingCandidates ? <p className="create-group-dm-modal__state">Carregando amigos...</p> : null}
          {!isLoadingCandidates && loadError ? <p className="create-group-dm-modal__state create-group-dm-modal__state--error">{loadError}</p> : null}
          {!isLoadingCandidates && !loadError && filteredCandidates.length === 0 ? (
            <p className="create-group-dm-modal__state">Nenhum amigo disponivel para convidar.</p>
          ) : null}

          {!isLoadingCandidates && !loadError ? filteredCandidates.map((candidate) => {
            const isSelected = selectedUserIds.includes(candidate.userId);
            return (
              <button
                key={candidate.userId}
                className={`create-group-dm-modal__candidate${isSelected ? " create-group-dm-modal__candidate--selected" : ""}`}
                type="button"
                role="listitem"
                onClick={() => toggleCandidate(candidate.userId)}
                disabled={isInviting}
              >
                <span className="create-group-dm-modal__candidate-avatar">
                  <AvatarImage
                    src={candidate.avatarSrc}
                    name={candidate.displayName}
                    alt={`Avatar de ${candidate.displayName}`}
                  />
                </span>
                <span className="create-group-dm-modal__candidate-meta">
                  <span className="create-group-dm-modal__candidate-name">{candidate.displayName}</span>
                  <span className="create-group-dm-modal__candidate-username">@{candidate.username}</span>
                </span>
              </button>
            );
          }) : null}
        </div>
      </div>
    </Modal>
  );
}
