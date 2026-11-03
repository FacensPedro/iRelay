; iRelay's installer: installs for all users (administrator rights, asked once
; by Windows) and adds the install folder to Microsoft Defender Antivirus'
; exclusions, so Defender does not scan or quarantine iRelay's own files.
; Uninstalling removes the exclusion. Nothing else on the PC is changed.

!macro customInstall
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Add-MpPreference -ExclusionPath ''$INSTDIR''"'
  Pop $0
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionPath ''$INSTDIR''"'
  Pop $0
!macroend
