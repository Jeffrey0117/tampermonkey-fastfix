' Runs the command in FASTFIX_RUN with no window, in the current folder, and does not wait for it.
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c " & sh.Environment("PROCESS")("FASTFIX_RUN"), 0, False
