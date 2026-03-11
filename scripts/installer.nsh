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
  ; Ensure a running tray instance does not block file replacement during reinstall/upgrade.
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM Messly.exe' $0
  Sleep 400

  ; Runs during install and update.
  StrCpy $0 "$INSTDIR\${MESSLY_EXECUTABLE_NAME}"
  IfFileExists "$0" +2 0
    Goto firewall_done

  ; Keep only one managed rule with the current installed executable path.
  ExecWait '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${MESSLY_FIREWALL_RULE_NAME}"' $1
  ExecWait '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${MESSLY_FIREWALL_RULE_NAME}" dir=in action=allow profile=private enable=yes program="$0"' $2

  StrCmp $2 0 firewall_ok firewall_failed

  firewall_ok:
    DetailPrint "Firewall: private rule ensured for $0"
    Goto firewall_done

  firewall_failed:
    ; Installer keeps running. Main process will retry on first bootstrap.
    DetailPrint "Firewall: rule not applied (likely no elevation). Bootstrap fallback remains active."

  firewall_done:
!macroend

!macro customUnInit
  ; Close a running tray/background instance before uninstall so it does not remain alive.
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM Messly.exe' $0
  Sleep 500
!macroend

!macro customUnInstall
  ; Best-effort cleanup: remove only the rule bound to this installed executable path.
  StrCpy $0 "$INSTDIR\${MESSLY_EXECUTABLE_NAME}"
  ExecWait '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${MESSLY_FIREWALL_RULE_NAME}" program="$0"' $1
!macroend
