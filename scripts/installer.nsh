; NSIS customization for electron-builder.
; Goal: Discord-like per-user install and silent uninstall behavior.

!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define MESSLY_UNINSTALL_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Messly"
!define MESSLY_INSTALL_ROOT "$LOCALAPPDATA\Messly"
!define MESSLY_EXECUTABLE_NAME "Messly.exe"
!define MESSLY_PUBLISHER "Mackstony Labs"
!define MESSLY_START_MENU_DIR "$SMPROGRAMS\Messly"

!macro preInit
  ; Force per-user install path in LocalAppData root.
  SetShellVarContext current
  StrCpy $INSTDIR "${MESSLY_INSTALL_ROOT}"
!macroend

!macro customInit
  ; Keep installer UI visible so users get immediate feedback.
  SetSilent normal
  SetDetailsPrint both
  DetailPrint "Inicializando instalador..."
!macroend

!ifdef BUILD_UNINSTALLER
Function un.EnableSilentUninstallFromUpdateExeArgs
  ; Support Update.exe --uninstall -s (Discord-like entrypoint).
  ${GetParameters} $R8
  ${GetOptions} $R8 "-s" $R9
  ${If} $R9 != ""
    SetSilent silent
  ${Else}
    ${GetOptions} $R8 "/S" $R9
    ${If} $R9 != ""
      SetSilent silent
    ${Else}
      ${GetOptions} $R8 "--silent" $R9
      ${If} $R9 != ""
        SetSilent silent
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd
!endif

!macro customInstall
  DetailPrint "Instalando Messly..."
  DetailPrint "Extraindo arquivos..."

  ; Ensure stale app processes are closed before file replacement.
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM ${MESSLY_EXECUTABLE_NAME}'
  Pop $0
  Sleep 120

  DetailPrint "Finalizando instalacao..."
  DetailPrint "Instalacao concluida."
!macroend

!ifdef BUILD_UNINSTALLER
!macro customUnInit
  ; Close running app instances and honor silent mode flags.
  Call un.EnableSilentUninstallFromUpdateExeArgs
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM ${MESSLY_EXECUTABLE_NAME}'
  Pop $0
  Sleep 220
!macroend

!macro customUnInstall
  ; Clean shortcuts and uninstall registry key.
  Delete "$DESKTOP\Messly.lnk"
  Delete "$SMPROGRAMS\Messly.lnk"
  RMDir /r "${MESSLY_START_MENU_DIR}"

  Delete "$INSTDIR\Update.exe"
  DeleteRegKey HKCU "${MESSLY_UNINSTALL_REG_KEY}"

  ; Keep %APPDATA%\Messly on purpose to preserve user session/settings.
  RMDir /r "$INSTDIR\packages"
  RMDir /r "$INSTDIR\app-${VERSION}"
  RMDir /r "$INSTDIR"
!macroend
!else
!macro customUnInit
!macroend

!macro customUnInstall
!macroend
!endif
