import { useEffect, useMemo, useState } from "react";
import { useAuthSession } from "../../auth/AuthProvider";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import AvatarImage from "../ui/AvatarImage";
import Modal from "../ui/Modal";
import styles from "./AccountCenterModal.module.css";

type AccountCenterMode = "overview" | "attach" | "swap";

interface AccountCenterModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialMode?: AccountCenterMode;
  targetUid?: string | null;
}

type FormFeedback = {
  tone: "error";
  message: string;
};

function resolveAuthErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: string }).code ?? "")
      : "";

  switch (code) {
    case "auth/invalid-email":
      return "Informe um e-mail válido.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "E-mail ou senha incorretos para esta conta.";
    case "auth/network-request-failed":
      return "Sem conexão. Verifique sua internet e tente novamente.";
    case "auth/too-many-requests":
      return "Muitas tentativas seguidas. Aguarde um pouco.";
    default:
      break;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String((error as { message?: string }).message ?? "").trim();
    if (message) {
      return message;
    }
  }

  return "Não foi possível autenticar esta conta agora.";
}

export default function AccountCenterModal({
  isOpen,
  onClose,
  initialMode = "overview",
  targetUid = null,
}: AccountCenterModalProps) {
  const { user, knownAccounts, authenticateAccount, signOutCurrent, forgetKnownAccount } = useAuthSession();
  const [mode, setMode] = useState<AccountCenterMode>("overview");
  const [targetAccountUid, setTargetAccountUid] = useState<string | null>(null);
  const [openRowMenuUid, setOpenRowMenuUid] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [feedback, setFeedback] = useState<FormFeedback | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [removingUid, setRemovingUid] = useState<string | null>(null);
  const uniqueKnownAccounts = useMemo(() => {
    const orderedAccounts = [...knownAccounts].sort((accountA, accountB) => {
      if (accountA.isActive !== accountB.isActive) {
        return accountA.isActive ? -1 : 1;
      }
      return accountB.lastUsedAt - accountA.lastUsedAt;
    });

    const seenUids = new Set<string>();
    const seenEmails = new Set<string>();
    const uniqueAccounts: typeof knownAccounts = [];

    for (const account of orderedAccounts) {
      const uid = String(account.uid ?? "").trim();
      const email = String(account.email ?? "").trim().toLowerCase();
      if (!uid || !email) {
        continue;
      }
      if (seenUids.has(uid) || seenEmails.has(email)) {
        continue;
      }
      seenUids.add(uid);
      seenEmails.add(email);
      uniqueAccounts.push(account);
    }

    return uniqueAccounts;
  }, [knownAccounts]);

  const activeUid = user?.uid ?? null;
  const targetAccount = useMemo(
    () => uniqueKnownAccounts.find((account) => account.uid === targetAccountUid) ?? null,
    [targetAccountUid, uniqueKnownAccounts],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setMode(initialMode);
    setTargetAccountUid(targetUid);
    setOpenRowMenuUid(null);
    setPasswordInput("");
    setFeedback(null);

    if (initialMode === "swap" && targetUid) {
      const knownTarget = uniqueKnownAccounts.find((account) => account.uid === targetUid);
      setEmailInput(knownTarget?.email ?? "");
      return;
    }

    if (initialMode === "attach") {
      setEmailInput("");
      return;
    }

    setEmailInput(user?.email ?? "");
  }, [initialMode, isOpen, targetUid, uniqueKnownAccounts, user?.email]);

  const headingLabel = useMemo(() => {
    if (mode === "attach") {
      return "Adicionar conta";
    }
    if (mode === "swap") {
      return "Trocar de conta";
    }
    return "Gerenciar contas";
  }, [mode]);

  const descriptionLabel = useMemo(() => {
    if (mode === "attach") {
      return "Adicione outra conta para alternar entre perfis neste dispositivo.";
    }
    if (mode === "swap") {
      const alias = targetAccount?.alias ?? "perfil";
      return `Confirme sua senha para entrar em ${alias}.`;
    }
    return "Acesse, troque e remova contas salvas neste dispositivo.";
  }, [mode, targetAccount?.alias]);

  const openAttachView = (): void => {
    setMode("attach");
    setTargetAccountUid(null);
    setOpenRowMenuUid(null);
    setEmailInput("");
    setPasswordInput("");
    setFeedback(null);
  };

  const openSwapView = (uid: string): void => {
    const nextTarget = uniqueKnownAccounts.find((account) => account.uid === uid);
    if (!nextTarget || nextTarget.uid === activeUid) {
      return;
    }

    setMode("swap");
    setTargetAccountUid(nextTarget.uid);
    setOpenRowMenuUid(null);
    setEmailInput(nextTarget.email);
    setPasswordInput("");
    setFeedback(null);
  };

  const openOverview = (): void => {
    setMode("overview");
    setTargetAccountUid(null);
    setOpenRowMenuUid(null);
    setPasswordInput("");
    setFeedback(null);
  };

  const handleAuthenticate = async (): Promise<void> => {
    const normalizedEmail = String(emailInput ?? "").trim().toLowerCase();
    if (!normalizedEmail) {
      setFeedback({ tone: "error", message: "Digite o e-mail da conta." });
      return;
    }
    if (!passwordInput) {
      setFeedback({ tone: "error", message: "Digite a senha para continuar." });
      return;
    }

    setIsSubmitting(true);
    setFeedback(null);

    try {
      await authenticateAccount({
        email: normalizedEmail,
        password: passwordInput,
        alias: mode === "swap" ? targetAccount?.alias : undefined,
      });
      onClose();
    } catch (error) {
      setFeedback({ tone: "error", message: resolveAuthErrorMessage(error) });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignOutCurrent = async (): Promise<void> => {
    setIsSigningOut(true);
    try {
      await signOutCurrent();
      onClose();
    } catch (error) {
      setFeedback({ tone: "error", message: resolveAuthErrorMessage(error) });
    } finally {
      setIsSigningOut(false);
    }
  };

  const handleForgetAccount = async (uid: string): Promise<void> => {
    setRemovingUid(uid);
    setOpenRowMenuUid(null);
    setFeedback(null);
    try {
      await forgetKnownAccount(uid);
    } catch (error) {
      setFeedback({ tone: "error", message: resolveAuthErrorMessage(error) });
    } finally {
      setRemovingUid(null);
    }
  };

  const showAuthForm = mode === "attach" || mode === "swap";
  const isAttachMode = mode === "attach";

  useEffect(() => {
    if (!isOpen || !openRowMenuUid) {
      return;
    }

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Element | null;
      if (!target?.closest?.("[data-account-row-menu='true']")) {
        setOpenRowMenuUid(null);
      }
    };

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpenRowMenuUid(null);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, openRowMenuUid]);

  return (
    <Modal
      isOpen={isOpen}
      title={headingLabel}
      ariaLabel={headingLabel}
      onClose={onClose}
      panelClassName={styles.panel}
      bodyClassName={styles.body}
    >
      <div className={styles.content}>
        <p className={styles.subtitle}>{descriptionLabel}</p>

        {!showAuthForm ? (
          <>
            <div className={styles.accountList}>
              {uniqueKnownAccounts.length === 0 ? (
                <p className={styles.emptyState}>Nenhuma conta salva ainda.</p>
              ) : (
                uniqueKnownAccounts.map((account) => {
                  return (
                    <article key={account.uid} className={styles.accountRow}>
                      <div className={styles.accountMain}>
                        <AvatarImage
                          className={styles.accountAvatar}
                          src={account.avatarSrc}
                          name={account.alias}
                          alt={`Avatar de ${account.alias}`}
                          loading="lazy"
                        />
                        <div className={styles.accountMeta}>
                          <p className={styles.accountAlias}>{account.alias}</p>
                          <p className={`${styles.accountEmail}${account.isActive ? ` ${styles.accountEmailActive}` : ""}`}>
                            {account.isActive ? "Conta atual" : account.email}
                          </p>
                        </div>
                      </div>

                      <div className={styles.accountActions}>
                        {!account.isActive ? (
                          <span className={styles.rowInlineAction}>
                            <button
                              type="button"
                              className={styles.rowButton}
                              onClick={() => openSwapView(account.uid)}
                            >
                              Entrar
                            </button>
                          </span>
                        ) : null}

                        <div className={styles.rowMoreWrap} data-account-row-menu="true">
                          <button
                            type="button"
                            className={styles.rowMoreButton}
                            aria-label={`Mais opções para ${account.alias}`}
                            onClick={() => {
                              setOpenRowMenuUid((current) => (current === account.uid ? null : account.uid));
                            }}
                          >
                            <MaterialSymbolIcon name="more_horiz" size={18} />
                          </button>

                          {openRowMenuUid === account.uid ? (
                            <div className={styles.rowMoreMenu} role="menu" data-account-row-menu="true">
                              {account.isActive ? (
                                <button
                                  type="button"
                                  role="menuitem"
                                  className={`${styles.rowMoreMenuItem} ${styles.rowMoreMenuItemDanger}`}
                                  onClick={() => {
                                    setOpenRowMenuUid(null);
                                    void handleSignOutCurrent();
                                  }}
                                  disabled={isSigningOut}
                                >
                                  {isSigningOut ? "Saindo..." : "Sair"}
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className={styles.rowMoreMenuItem}
                                    onClick={() => {
                                      setOpenRowMenuUid(null);
                                      openSwapView(account.uid);
                                    }}
                                  >
                                    Entrar
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className={`${styles.rowMoreMenuItem} ${styles.rowMoreMenuItemDanger}`}
                                    onClick={() => {
                                      setOpenRowMenuUid(null);
                                      void handleForgetAccount(account.uid);
                                    }}
                                    disabled={removingUid === account.uid}
                                  >
                                    {removingUid === account.uid ? "Removendo..." : "Remover"}
                                  </button>
                                </>
                              )}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  );
                })
              )}
            </div>

            <div className={styles.bottomActions}>
              <button type="button" className={styles.primaryButton} onClick={openAttachView}>
                Adicionar conta
              </button>
            </div>
          </>
        ) : (
          <>
            <div className={styles.formField}>
              <label className={styles.fieldLabel} htmlFor="account-center-email">
                E-mail
                <span className={styles.requiredMark} aria-hidden="true">
                  *
                </span>
              </label>
              <input
                id="account-center-email"
                className={styles.fieldInput}
                type="email"
                placeholder="voce@exemplo.com"
                value={emailInput}
                onChange={(event) => setEmailInput(event.target.value)}
                autoComplete="email"
                disabled={mode === "swap" || isSubmitting}
              />
            </div>

            <div className={styles.formField}>
              <label className={styles.fieldLabel} htmlFor="account-center-password">
                Senha{" "}
                <span className={styles.requiredMark} aria-hidden="true">
                  *
                </span>
              </label>
              <input
                id="account-center-password"
                className={styles.fieldInput}
                type="password"
                placeholder="Sua senha"
                value={passwordInput}
                onChange={(event) => setPasswordInput(event.target.value)}
                autoComplete="current-password"
                disabled={isSubmitting}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleAuthenticate();
                  }
                }}
              />
            </div>

            <div className={`${styles.bottomActions} ${styles.authActions}`}>
              <button
                type="button"
                className={`${styles.backButton} ${styles.authBackButton}`}
                onClick={openOverview}
                disabled={isSubmitting}
              >
                Voltar
              </button>
              <button
                type="button"
                className={`${styles.primaryButton} ${styles.authPrimaryButton}`}
                onClick={() => {
                  void handleAuthenticate();
                }}
                disabled={isSubmitting}
              >
                {isSubmitting ? "Entrando..." : "Entrar"}
              </button>
            </div>
          </>
        )}

        {feedback ? <p className={styles.feedbackError}>{feedback.message}</p> : null}
      </div>
    </Modal>
  );
}


