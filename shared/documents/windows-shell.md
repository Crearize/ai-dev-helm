# Windows Shell Rules

Shell pitfalls on Windows. The entry files (`CLAUDE.md` / `AGENTS.md` / `.cursorrules`) keep the six core PowerShell rules; this document holds the rest.

## Control characters and heredocs

- Do not put control characters (tab, CR, ESC, BEL) literally in commands or paths; use escapes in a script file.
- In a bash heredoc, a backslash before a newline or `$` is interpreted unless the delimiter is quoted (`<<'EOF'`).
- In PowerShell, use single-quoted here-strings (`@'...'@`); the closing `'@` must be at column 0.

## Paths

- Do not `cd` to a relative path you have not checked; use an absolute path.
- Git Bash (MSYS) rewrites arguments that look like POSIX paths. For a Windows-native command, set `MSYS_NO_PATHCONV=1` or double the slash.
- Stopping a process from Git Bash: `taskkill //PID <pid> //F` (add `//T` for the tree). `taskkill /PID ...` fails with "invalid argument" because `/PID`, `/F` and `/T` are converted to paths. Alternative: `powershell -NoProfile -Command "taskkill /PID <pid> /T /F"`.
- After stopping a server, confirm the port is free: `netstat -ano | grep ":<port> .*LISTEN"` must print nothing.

## PowerShell

- Piping a string to a native command encodes it with `$OutputEncoding`; set `$OutputEncoding = [Text.UTF8Encoding]::new($false)` first when the text is non-ASCII.

## curl and Python

- curl: send a request body from stdin with `--data-binary @-` (plain `-d @-` strips newlines).
- Python: open files with `encoding='utf-8'` and, when writing text that must keep its line endings, `newline=''`.
