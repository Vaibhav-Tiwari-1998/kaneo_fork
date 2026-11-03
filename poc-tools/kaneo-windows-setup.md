# Kaneo POC setup on Windows Server 2022

**Code:** your fork `Vaibhav-Tiwari-1998/kaneo_fork`, branch `main`, imported into GitLab. It is official Kaneo (commit `dd92f6bc9b5f86b3b4dfc396026350d220e129a5`, Better Auth 1.7.14) plus one commit that:

- removes the need for `@better-auth/kysely-adapter`
- adds a `poc-tools` folder with the mirror checker

**Rules for every step:**

- Run commands in **Windows PowerShell** (Start → Windows PowerShell), not Command Prompt.
- "Reopen PowerShell" means close the window and open a new one.
- Don't edit `package.json`, `pnpm-lock.yaml` or `pnpm-workspace.yaml`.
- Don't run `pnpm update`, or `pnpm install` without `--frozen-lockfile`.

---

## 0. What to get first

| Item | Details |
| --- | --- |
| Node.js | Version 24.15 or newer (or 26+), Windows x64, from your software portal or internal mirror |
| npm mirror | The npm repository URL on mitmnx or packagenexus, plus a login token if it needs one |
| Kaneo code | GitLab import of `https://github.com/Vaibhav-Tiwari-1998/kaneo_fork`, branch `main` |
| PostgreSQL | PostgreSQL 16 or newer, with a database `kaneo` **owned by** a user `kaneo` (Kaneo creates its own tables). No extensions are needed. The host and port must be reachable from the VM |
| Certificate (if needed) | The company root CA as a `.pem` file, if the mirror or the database uses internal certificates |

---

## 1. Check Node.js

```powershell
node --version
npm --version
```

`node --version` must show **v24.15.0 or newer**, or **v26 or newer**.

If Node.js came as a zip rather than an installer, extract it to `C:\tools\node`, run this, then reopen PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("Path", "C:\tools\node;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
```

---

## 2. Point npm at the internal mirror

```powershell
npm config set registry https://<npm-mirror-host>/repository/<npm-repo>/
```

If the mirror needs a login:

```powershell
npm config set "//<npm-mirror-host>/repository/<npm-repo>/:_authToken" "<token>"
```

If the mirror uses a company certificate, run this, then reopen PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("NODE_EXTRA_CA_CERTS", "C:\certs\company-ca.pem", "User")
```

Test it. This should print `1.7.14`:

```powershell
npm view better-auth@1.7.14 version
```

---

## 3. Download and extract the Kaneo code

1. In GitLab, open the imported `kaneo_fork` repo, select branch **main**, then choose **Code → Download source code → zip**.
2. Extract it to `C:\dev` and rename the folder to `kaneo`:

   ```powershell
   New-Item -ItemType Directory -Force C:\dev | Out-Null
   Unblock-File "$HOME\Downloads\<downloaded-zip-name>.zip"
   Expand-Archive "$HOME\Downloads\<downloaded-zip-name>.zip" -DestinationPath C:\dev
   Get-ChildItem C:\dev
   Rename-Item "C:\dev\<extracted-folder-name>" kaneo
   ```

3. Check you have the right code. All three must succeed (a match, then `True`, then `True`):

   ```powershell
   Select-String -Path C:\dev\kaneo\apps\api\src\auth.ts -Pattern 'better-auth/minimal'
   Test-Path "C:\dev\kaneo\patches\@better-auth__api-key@1.7.14.patch"
   Test-Path C:\dev\kaneo\poc-tools\check-deps.mjs
   ```

---

## 4. Check that every package is on the mirror

This checks the 1,583 packages Kaneo needs on Windows, including pnpm itself, before you install anything.

```powershell
cd C:\dev\kaneo
node poc-tools\check-deps.mjs
```

It uses the registry from Step 2. To check a different one, add `--registry https://<host>/repository/<npm-repo>/`.

If the mirror needs a login, set **one** of these first, in the same PowerShell window:

```powershell
$env:REGISTRY_TOKEN = "<token>"
# or
$env:REGISTRY_USER = "<user>"; $env:REGISTRY_PASSWORD = "<password>"
```

| Result | Meaning | What to do |
| --- | --- | --- |
| `All packages are available` | Everything is on the mirror | Continue |
| `MISSING_PACKAGE` / `MISSING_VERSION` | The mirror doesn't have it | Ask the repository team to add it |
| `TARBALL_BLOCKED` / `AUTH_OR_BLOCKED` | The download is refused by policy | Ask security to approve it |
| `INTEGRITY_MISMATCH` | The mirror's file differs from what Kaneo expects | **Stop** and report it. Don't install |

Failures are listed in `C:\dev\kaneo\poc-tools\missing-packages.txt`, which you can send as-is. Full results are in `poc-tools\check-report.csv`.

**Don't continue until it says `All packages are available`.**

---

## 5. Install pnpm 12.15.0 (exactly this version)

```powershell
npm install -g pnpm@12.15.0
pnpm --version
pnpm config get registry
```

Expect `12.15.0`, then your mirror URL. If pnpm later says "Update available", ignore it.

If PowerShell says **"running scripts is disabled"**:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

If company policy blocks that, type `pnpm.cmd` instead of `pnpm` in every command below.

---

## 6. Allow long file paths (if you have admin rights)

In PowerShell **as Administrator**:

```powershell
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
```

Without admin rights, skip this. `C:\dev\kaneo` is a short enough path.

---

## 7. Check that the database is reachable

```powershell
Test-NetConnection <db-host> -Port 5432
```

You need `TcpTestSucceeded : True`.

---

## 8. Create the settings file

```powershell
cd C:\dev\kaneo
Copy-Item .env.sample .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
notepad .env
```

Copy the long string that `node` prints. In Notepad:

1. Make sure these four lines exist exactly like this, with no `#` in front and nothing after the value. `KANEO_API_URL` and `DATABASE_URL` are commented out in the sample, so uncomment or add them:

   ```
   KANEO_CLIENT_URL=http://localhost:5173
   KANEO_API_URL=http://localhost:1337
   DATABASE_URL=postgresql://kaneo:<db-password>@<db-host>:5432/kaneo
   AUTH_SECRET=<the long string>
   ```

2. Adjust the database URL if needed:
   - **Encrypted connections:** add `?sslmode=require` to the end of `DATABASE_URL` if the database requires them.
   - **Special characters in the password:** URL-encode them: `@` → `%40`, `#` → `%23`, `/` → `%2F`, `:` → `%3A`.
   - **Connection limit:** if the database user has one, add a line `DATABASE_POOL_MAX=5`.
3. Save. If Notepad asks for an encoding, choose **UTF-8**, not "UTF-8 with BOM".

Check the result without printing the secret. Expect the three URL lines, then `1`:

```powershell
Select-String -Path .env -Pattern '^(KANEO_CLIENT_URL|KANEO_API_URL|DATABASE_URL)='
(Select-String -Path .env -Pattern '^AUTH_SECRET=.+').Count
```

---

## 9. Install dependencies

```powershell
cd C:\dev\kaneo
pnpm install --frozen-lockfile --filter . --filter "@kaneo/api..." --filter "@kaneo/web..."
```

- **What it does:** installs exactly the versions in Kaneo's lockfile, about 1,580 packages, and only what the API, the web app and their shared packages need. It also applies the Better Auth API-key patch automatically.
- **How long:** the first run can take 10 minutes or more.
- **Safe to ignore:** "Update available" and "Ignored build scripts".
- **If it stops** with `403`, `404` or `ERR_PNPM_FETCH`, the named package is blocked or missing on the mirror. Ask the repository team to add it, then run the same command again.

---

## 10. Build the shared packages

```powershell
pnpm --filter @kaneo/email --filter @kaneo/importers --filter @kaneo/permissions --filter @kaneo/mcp --filter @kaneo/editor run build
Test-Path C:\dev\kaneo\packages\mcp\dist\index.js
```

The last line should print `True`.

---

## 11. Start the API (PowerShell window 1)

```powershell
cd C:\dev\kaneo
pnpm --filter ./apps/api exec tsx src/index.ts
```

Wait for `Database migrated successfully!` and then `API is running at http://localhost:1337`. Keep this window open.

- "Social provider github/google/discord is missing clientId" warnings are fine.
- `Drizzle schema mismatch` or `Cannot find package '@better-auth/kysely-adapter'` means the code isn't the fork version. Recheck Step 3.

---

## 12. Start the web app (PowerShell window 2)

```powershell
cd C:\dev\kaneo
pnpm --filter ./apps/web run dev
```

Wait for `Local: http://localhost:5173/`. Keep this window open.

If Windows Firewall asks about Node.js, you can decline. `localhost` works either way, and declining keeps Kaneo off the network.

---

## 13. Sign up and try it

1. In a browser on the VM, open **http://localhost:5173**.
2. Sign up. The first account becomes the admin.
3. Create a workspace, a project and a few tasks.
4. Go to **Settings → Account → Developer Settings**, create an API key and save it. You'll need it later to connect Claude.

---

## 14. Check that data survives a restart

Press **Ctrl+C** in both windows, run Steps 11 and 12 again, and refresh the browser. Your account and tasks should still be there, because they're stored in PostgreSQL.

---

## Everyday commands

| What | Command |
| --- | --- |
| Start the API | `cd C:\dev\kaneo; pnpm --filter ./apps/api exec tsx src/index.ts` |
| Start the web app | `cd C:\dev\kaneo; pnpm --filter ./apps/web run dev` |
| Open Kaneo | http://localhost:5173 |
| Stop | Ctrl+C in each window |

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "running scripts is disabled" | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `pnpm.cmd` |
| "is not recognized as the name of a cmdlet" | Reopen PowerShell; check that Node.js's folder is on PATH |
| Checker: "Cannot reach …" | Check the mirror URL, VPN or proxy, and `NODE_EXTRA_CA_CERTS` |
| Checker: "401 Unauthorized" | Set `$env:REGISTRY_TOKEN` (or `REGISTRY_USER` and `REGISTRY_PASSWORD`) in the same window |
| `ERR_PNPM_FETCH_403` / `404` | The package is blocked or missing on the mirror. Ask for it, then rerun Step 9 |
| `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` or `SELF_SIGNED_CERT_IN_CHAIN` | Set `NODE_EXTRA_CA_CERTS` to the company CA (Step 2), then reopen PowerShell |
| "Cannot install with frozen-lockfile" | A file was edited, or the code isn't the fork's `main`. Download it again |
| A patch error during install | The lockfile or the patch file was changed. Download the code again |
| "Filename too long", `EPERM` or `EBUSY` | Enable long paths (Step 6). If antivirus is locking files, retry, or ask IT to exclude `C:\dev` |
| "VCRUNTIME140.dll was not found" | Ask IT for the Microsoft Visual C++ Redistributable (x64) |
| API: "Database startup failed for host:port/kaneo" | Check `DATABASE_URL`, the password encoding and Step 7. The DBA may need to allow the VM's IP |
| API: certificate error with `sslmode=require` | The database uses an internal certificate. Set `NODE_EXTRA_CA_CERTS` to its CA |
| API: "permission denied for schema public" | The `kaneo` user must own the `kaneo` database. Ask the DBA |
| API: `Cannot find package '@better-auth/kysely-adapter'` | The code isn't the fork version. Recheck Step 3 |
| Page loads but sign-in fails | `KANEO_CLIENT_URL` and `KANEO_API_URL` must match Step 8 exactly, with no trailing slash. Restart the API |
| "Port already in use" | `Get-NetTCPConnection -LocalPort 1337,5173` shows which process holds the port |
