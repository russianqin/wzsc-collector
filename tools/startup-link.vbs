Option Explicit
' Create or remove the "start with Windows" shortcut for the watchdog.
' usage:
'   cscript //nologo tools\startup-link.vbs add "<linkPath>" "<watchdogVbs>"
'   cscript //nologo tools\startup-link.vbs remove "<linkPath>"

Dim fso, shell, args, mode, linkPath, watchdog, link
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments

If args.Count < 2 Then
  WScript.Echo "usage: startup-link.vbs add|remove <linkPath> [watchdogVbs]"
  WScript.Quit 2
End If

mode = LCase(args(0))
linkPath = args(1)

If mode = "remove" Then
  If fso.FileExists(linkPath) Then fso.DeleteFile linkPath, True
  WScript.Echo "removed"
  WScript.Quit 0
End If

If args.Count < 3 Then
  WScript.Echo "missing watchdog path"
  WScript.Quit 2
End If

watchdog = args(2)
Set link = shell.CreateShortcut(linkPath)
link.TargetPath = "wscript.exe"
link.Arguments = """" & watchdog & """"
link.WorkingDirectory = fso.GetParentFolderName(watchdog)
link.WindowStyle = 7
link.Description = "wzsc-collector: local service follows the browser"
link.Save
WScript.Echo "created"
