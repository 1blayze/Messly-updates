; NSIS customization for electron-builder.
; Goal: Discord-like per-user install and silent uninstall behavior.

!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define MESSLY_UNINSTALL_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Messly"
!define MESSLY_INSTALL_ROOT "$LOCALAPPDATA\Messly"
!define MESSLY_EXECUTABLE_NAME "Messly.exe"
!define MESSLY_PUBLISHER "Mackstony Labs"

!macro preInit
  ; Force per-user install path in LocalAppData root.
  SetShellVarContext current
  StrCpy $INSTDIR "${MESSLY_INSTALL_ROOT}"
!macroend

!macro customInit
  ; Reserved for future runtime init customization.
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
  ; Hidden execution to avoid command window flashes during install/update.
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM ${MESSLY_EXECUTABLE_NAME}'
  Pop $0
  Sleep 220

  ; Keep a Discord-like layout contract expected by enterprise scripts.
  CreateDirectory "$INSTDIR\packages"
  CreateDirectory "$INSTDIR\app-${VERSION}"
  IfFileExists "$INSTDIR\${MESSLY_EXECUTABLE_NAME}" 0 +2
    CopyFiles /SILENT "$INSTDIR\${MESSLY_EXECUTABLE_NAME}" "$INSTDIR\app-${VERSION}\${MESSLY_EXECUTABLE_NAME}"

  ; Create Update.exe shim by copying the generated uninstaller binary.
  Delete "$INSTDIR\Update.exe"
  IfFileExists "$INSTDIR\Uninstall Messly.exe" copy_named_uninstaller try_plain_uninstall
copy_named_uninstaller:
  CopyFiles /SILENT "$INSTDIR\Uninstall Messly.exe" "$INSTDIR\Update.exe"
  Goto update_shim_done
try_plain_uninstall:
  IfFileExists "$INSTDIR\uninstall.exe" 0 update_shim_done
  CopyFiles /SILENT "$INSTDIR\uninstall.exe" "$INSTDIR\Update.exe"
update_shim_done:

  WriteRegStr HKCU "${MESSLY_UNINSTALL_REG_KEY}" "DisplayName" "Messly"
  WriteRegStr HKCU "${MESSLY_UNINSTALL_REG_KEY}" "Publisher" "${MESSLY_PUBLISHER}"
  WriteRegStr HKCU "${MESSLY_UNINSTALL_REG_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${MESSLY_UNINSTALL_REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${MESSLY_UNINSTALL_REG_KEY}" "UninstallString" '$\"$INSTDIR\Update.exe$\" --uninstall -s'
  WriteRegStr HKCU "${MESSLY_UNINSTALL_REG_KEY}" "QuietUninstallString" '$\"$INSTDIR\Update.exe$\" --uninstall -s'
  WriteRegDWORD HKCU "${MESSLY_UNINSTALL_REG_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${MESSLY_UNINSTALL_REG_KEY}" "NoRepair" 1
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
  RMDir /r "$SMPROGRAMS\Messly"

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
