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
  ; Reserved for future custom steps (e.g. post-install tasks)
!macroend

!macro customUnInit
  ; Reserved for future uninstall customization
!macroend
