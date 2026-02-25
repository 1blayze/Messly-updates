; NSIS customization for electron-builder.
; Goal: one-click, per-user install, no folder chooser.

!macro preInit
  ; Force per-user install path in LocalAppData
  SetShellVarContext current
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Messly"
!macroend

!macro customInit
  ; Reserved for future runtime init customization
!macroend

!macro customInstall
  ; Ensure a running tray instance does not block file replacement during reinstall/upgrade.
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM Messly.exe' $0
  Sleep 400
!macroend

!macro customUnInit
  ; Close a running tray/background instance before uninstall so it does not remain alive.
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM Messly.exe' $0
  Sleep 500
!macroend
