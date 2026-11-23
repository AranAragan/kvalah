; Extra NSIS steps for kvalah (included by electron-builder, see nsis.include).

!macro customInstall
  ; Upgrade from the pre-0.7 custom installer (Setup.exe), which used the same folder
  ; %LOCALAPPDATA%\Programs\kvalah. Remove only its own leftovers; user data lives in %APPDATA%\kvalah.
  ${if} ${FileExists} "$INSTDIR\.kvalah-installed-files.txt"
    Delete "$INSTDIR\Uninstall.exe"
    Delete "$INSTDIR\.kvalah-installed-files.txt"
    Delete "$INSTDIR\.owner"
    Delete "$INSTDIR\README-WINDOWS.txt"
    RMDir /r "$INSTDIR\resources\app\vendor"
    RMDir /r "$INSTDIR\resources\app\tools"
    Delete "$INSTDIR\resources\app\START.cmd"
    Delete "$INSTDIR\resources\app\START.vbs"
    Delete "$INSTDIR\resources\app\README-WINDOWS.txt"
    Delete "$SMPROGRAMS\kvalah\kvalah.lnk"
    RMDir "$SMPROGRAMS\kvalah"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\kvalah"
  ${endIf}
!macroend
