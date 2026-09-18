' Starts the read-only trading dashboard (http://localhost:3000) with no console
' window. Windows twin of the macOS LaunchAgent described in RUNBOOK.md.
' Used by the shortcut in the Windows Startup folder. If something already
' holds port 3000 the dashboard exits harmlessly (EADDRINUSE).
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run "cmd /c node dashboard-server.mjs >> """ & root & "\sessions\dashboard.log"" 2>&1", 0, False
