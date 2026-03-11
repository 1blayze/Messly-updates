; NSIS customization for electron-builder.
; This file runs during install/update/uninstall and keeps per-user LocalAppData behavior.

!define MESSLY_FIREWALL_RULE_NAME "Messly Private Network Access"
!define MESSLY_EXECUTABLE_NAME "Messly.exe"

!macro preInit
  ; Force per-user install path in LocalAppData.
  SetShellVarContext current
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Messly"
!macroend

!macro customInit
  ; Reserved for future runtime init customization.
!macroend

!macro customInstall
  ; Silent/hidden execution to avoid command window flashes during install/update.
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM ${MESSLY_EXECUTABLE_NAME}'
  Pop $0
  Sleep 220

  ; Firewall provisioning is handled by the main process bootstrap.
  ; Keeping installer side-effects minimal improves speed and avoids console popups.
!macroend

!macro customUnInit
  ; Close a running tray/background instance before uninstall so it does not remain alive.
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM ${MESSLY_EXECUTABLE_NAME}'
  Pop $0
  Sleep 300
!macroend

!macro customUnInstall
  ; Keep uninstall silent. Runtime bootstrap manages firewall lifecycle.
!macroend
