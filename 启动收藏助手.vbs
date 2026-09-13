Option Explicit
' wzsc-collector watchdog (runs hidden, no window, a few MB).
'   browser is running -> make sure the local service is running (so clicking the
'                         extension is instant)
'   no browser         -> the service exits by itself; this script keeps waiting
' Stop everything with "2-取消安装.cmd".
' Self check: cscript //nologo "启动收藏助手.vbs" check

Dim fso, shell, base, nodeExe, serverJs, stopFile, lockFile, ts, txt
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
serverJs = base & "\src\server.js"
stopFile = base & "\stop.txt"
lockFile = shell.ExpandEnvironmentStrings("%TEMP%") & "\wzsc-watchdog.lock"

nodeExe = "node"
If fso.FileExists(base & "\node-path.txt") Then
  Set ts = fso.OpenTextFile(base & "\node-path.txt", 1)
  txt = Trim(ts.ReadAll)
  ts.Close
  If Len(txt) > 0 Then nodeExe = txt
End If

Dim wantCheck
wantCheck = False
If WScript.Arguments.Named.Exists("check") Then
  wantCheck = True
ElseIf WScript.Arguments.Unnamed.Count > 0 Then
  ' 注意：VBScript 的 And 不是短路运算，所以这里必须分成两步判断
  If LCase(WScript.Arguments.Unnamed(0)) = "check" Then wantCheck = True
End If

If wantCheck Then
  WScript.Echo "node: " & nodeExe
  WScript.Echo "server script: " & serverJs
  WScript.Echo "browser running: " & YesNo(BrowserUp())
  WScript.Echo "service responding: " & YesNo(ServiceUp())
  WScript.Quit 0
End If

' single instance: another watchdog refreshed the lock file a few seconds ago
If AlreadyRunning() Then WScript.Quit 0

Dim browserOn, serviceOn

Do
  If fso.FileExists(stopFile) Then
    On Error Resume Next
    fso.DeleteFile lockFile, True
    On Error Goto 0
    WScript.Quit 0
  End If

  TouchLock

  browserOn = BrowserUp()
  serviceOn = ServiceUp()

  If browserOn Then
    If Not serviceOn Then
      Log "starting service (" & nodeExe & ")"
      On Error Resume Next
      shell.Run """" & nodeExe & """ """ & serverJs & """", 0, False
      If Err.Number <> 0 Then
        Log "start failed: " & Err.Number & " " & Err.Description
        Err.Clear
      End If
      On Error Goto 0
    Else
      Log "tick: browser=yes service=yes"
    End If
  Else
    Log "tick: browser=no service=" & YesNo(serviceOn)
  End If

  WScript.Sleep 5000
Loop

Sub Log(text)
  Dim dir, f
  On Error Resume Next
  dir = fso.GetParentFolderName(WScript.ScriptFullName) & "\debug"
  If Not fso.FolderExists(dir) Then fso.CreateFolder(dir)
  Set f = fso.OpenTextFile(dir & "\watchdog.log", 8, True)
  f.WriteLine Now & "  " & text
  f.Close
  Err.Clear
End Sub

Function YesNo(value)
  If value Then
    YesNo = "yes"
  Else
    YesNo = "no"
  End If
End Function

Function AlreadyRunning()
  Dim age
  AlreadyRunning = False
  On Error Resume Next
  If Not fso.FileExists(lockFile) Then Exit Function
  age = DateDiff("s", fso.GetFile(lockFile).DateLastModified, Now)
  If Err.Number = 0 Then
    If age < 20 Then AlreadyRunning = True
  End If
  Err.Clear
End Function

Sub TouchLock()
  Dim f
  On Error Resume Next
  Set f = fso.CreateTextFile(lockFile, True)
  f.Write Now
  f.Close
  Err.Clear
End Sub

Function BrowserUp()
  Dim state
  state = BrowserStateWmi()
  If state >= 0 Then
    BrowserUp = (state > 0)
    Exit Function
  End If
  state = BrowserStateTasklist()
  If state >= 0 Then
    BrowserUp = (state > 0)
  Else
    ' 完全查不出来时，宁可让服务在跑（反正浏览器关了它自己会下班）
    BrowserUp = True
  End If
End Function

' 1 = running, 0 = not running, -1 = cannot tell
Function BrowserStateWmi()
  Dim wmi, list, p
  BrowserStateWmi = -1
  On Error Resume Next
  Set wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2")
  If Err.Number <> 0 Then Err.Clear : Exit Function
  Set list = wmi.ExecQuery("SELECT Name FROM Win32_Process WHERE Name='msedge.exe' OR Name='chrome.exe' OR Name='brave.exe' OR Name='vivaldi.exe'")
  If Err.Number <> 0 Then Err.Clear : Exit Function
  BrowserStateWmi = 0
  For Each p In list
    BrowserStateWmi = 1
    Exit Function
  Next
End Function

Function BrowserStateTasklist()
  Dim tmp, out, f
  BrowserStateTasklist = -1
  On Error Resume Next
  tmp = shell.ExpandEnvironmentStrings("%TEMP%") & "\wzsc-tasklist.txt"
  shell.Run "%ComSpec% /c tasklist /NH > """ & tmp & """", 0, True
  If Err.Number <> 0 Then Err.Clear : Exit Function
  Set f = fso.OpenTextFile(tmp, 1)
  out = LCase(f.ReadAll)
  f.Close
  fso.DeleteFile tmp, True
  If Err.Number <> 0 Then Err.Clear : Exit Function
  If InStr(out, "explorer.exe") = 0 Then Exit Function
  If InStr(out, "msedge.exe") > 0 Or InStr(out, "chrome.exe") > 0 Or InStr(out, "brave.exe") > 0 Or InStr(out, "vivaldi.exe") > 0 Then
    BrowserStateTasklist = 1
  Else
    BrowserStateTasklist = 0
  End If
End Function

' 端口上有"我们这版或更新"的服务在响应就算在运行
Function ServiceUp()
  Dim port, http, body, pos, v
  ServiceUp = False
  For port = 8765 To 8768
    On Error Resume Next
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.setTimeouts 300, 300, 800, 800
    http.open "GET", "http://127.0.0.1:" & port & "/health", False
    http.send
    If Err.Number = 0 Then
      If http.Status = 200 Then
        body = http.responseText
        If InStr(body, """ok"":true") > 0 Then
          pos = InStr(body, """version"":""")
          If pos > 0 Then
            v = Mid(body, pos + 11)
            v = Left(v, InStr(v, """") - 1)
            If v >= "0.3.0" Then ServiceUp = True
          End If
        End If
      End If
    End If
    Err.Clear
    If ServiceUp Then Exit Function
  Next
End Function
