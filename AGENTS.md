# Local Codex Instructions

## Windows process launches

When starting package-manager scripts in the background with `Start-Process`, do not use bare `pnpm`, `npm`, or `yarn` as the executable. On Windows this can resolve through file associations differently than an interactive shell.

Use the command shim explicitly:

```powershell
Start-Process -FilePath "pnpm.cmd" -ArgumentList "dev" -WorkingDirectory "C:\projects\walletbot" -WindowStyle Hidden
```

Alternatively, run through `cmd.exe`:

```powershell
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "pnpm dev" -WorkingDirectory "C:\projects\walletbot" -WindowStyle Hidden
```
