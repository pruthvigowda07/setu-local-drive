# Setu

A small, local-first file inbox for Windows. Receive files and folders on your PC through approved, resumable upload links. The browser dashboard runs on your computer. No hosted website, domain, npm install, or database service is required.

The **Windows installer includes Node.js and cloudflared**. No separate runtime install is needed. Running from source requires Node.js 24 or newer. There are no production npm dependencies. Node's built-in SQLite API currently prints an experimental-feature notice; this is expected.

## Windows desktop installation

Setu starts in dark mode. Change it under **Settings → Appearance** to Dark, Light, or Match Windows. Your choice is saved on each device, and the desktop window follows it.

Run `dist/Setu Setup.exe`. It installs for your Windows account, adds Desktop and Start menu shortcuts, and registers Setu in Windows Installed apps. No administrator access, startup service, or automatic receiving is configured. This is an unsigned local build, not a commercially signed installer.

Setu is released under the MIT License. Release signing is manual and follows
the policy in [CODE_SIGNING.md](CODE_SIGNING.md).

- Double-click **Setu** to open its own dedicated Windows application window and automatically unlock the dashboard. No browser tab or owner-key entry is needed. It uses the Microsoft Edge WebView2 Runtime already present on this PC, rather than launching Edge or Chrome. Other PCs need the [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).
- The tray icon offers **Open dashboard**, **Pause receiving**, **Open app data folder**, and **Exit Setu**. Opening another shortcut brings the same window forward. Minimize the window to keep receiving; closing it exits Setu and stops the tunnel.
- App binaries: `%LOCALAPPDATA%\Harbor\App`.
- Credentials, catalogue, partial uploads and desktop logs: `%LOCALAPPDATA%\Harbor\Data`.
- New installations default to `Documents\Harbor Inbox`; this PC's existing chosen inbox is preserved during migration.
- Uninstall removes program files and shortcuts but keeps uploaded files and app data. The small running uninstaller remains until you delete it after it closes.
- The local listener uses port 4783. Exit any source-code instance before opening the installed app.

The owner key is a randomly generated credential stored under Windows DPAPI protection. It is not your Windows password. The launcher retrieves it under your Windows account and passes it to the embedded local dashboard; the page exchanges it for a session cookie and removes it from the address. The embedded browser profile is kept under `Data/WebView2`. Other remote navigation and new-window popups are blocked in the embedded view.

Build the self-contained installer from this source with `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1`. It includes the web app, a small native tray launcher, Node, cloudflared and their license notices. User data, `.env`, and owner keys are never included in the installer. The roughly 50 MB installer size is mainly the bundled runtimes; no Electron browser is included.

## Start on this PC

Double-click **Start Setu.cmd**, or run:

```powershell
npm start
```

Open the **private owner dashboard link printed in the terminal**. The key is exchanged for an HttpOnly, SameSite=Strict session cookie and removed from the URL. Do not share this link. Owner sessions last 12 hours and end when Setu restarts.

1. Choose an inbox in Settings (default: this project's `inbox` folder).
2. Enable receiving for a limited time.
3. Choose files or a folder, or drop them into the dashboard.
4. Use Upload requests to create an invitation, with an expiry and total allowance. New uploads are saved to this PC's inbox.
5. The sender enters a name and receives a pairing code. Confirm that code with the sender, then approve the device.

Guest names are self-reported; they are **not verified identities or verified email addresses**. Approval is per browser session. Guests can upload and see their own receipts, not browse or download your library.

Receiving starts **paused on every launch**. Pausing prevents new chunks and closes an active tunnel. One already-dispatched chunk may finish; completed bytes are not rolled back. Close the terminal / press Ctrl+C to stop the app.

If Setu was started in the background by Codex, double-click **Stop Setu.cmd** to close that instance before running either launcher. The stop launcher targets the recorded Node process for this project and its tunnel child; it does not stop unrelated Node applications. A forced stop preserves acknowledged upload chunks for resumption. It uses the default `data` location; with a custom `LOCAL_DATA_DIR`, stop the original terminal process instead.

## Receive from your phone or another computer on Wi-Fi

Double-click **Start Setu on Wi-Fi.cmd**, or run:

```powershell
npm run start:lan
```

Open the owner link on the host PC. Settings lists local-network addresses. When creating an upload link, choose the appropriate Wi-Fi address rather than `127.0.0.1`. Both devices must be on a network that allows them to communicate.

Windows Firewall may require allowing Node on your **private** network. Setu does not change firewall rules or configure your router. LAN mode binds to all IPv4 interfaces, so use it only with appropriate local firewall rules. Stop the app to close its listener. The receiving switch disables upload acceptance, while the dashboard listener remains available.

LAN traffic uses HTTP and is suitable only for a trusted home network. Use HTTPS through a tunnel for remote or untrusted networks. Administrator APIs additionally require a loopback connection, a local Host header, and no forwarding headers; guests cannot administer the PC over LAN or the tunnel.

## Optional remote receiving, no domain required

Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) and make it available on PATH, or set `CLOUDFLARED_PATH` in `.env` to the full path of its portable executable. Restart Setu after installation. This PC uses a checksum-verified portable copy in `%LOCALAPPDATA%\Harbor\bin`, configured through `.env`.

1. Enable receiving.
2. Open Settings → Temporary remote access → Start temporary tunnel.
3. Wait for the HTTPS `trycloudflare.com` address.
4. Create an upload link and select that address.
5. Approve the sender's pairing code.
6. Stop the tunnel when finished. It also stops when the receiving window ends.

The app starts its own cloudflared process, uses an outbound tunnel to the local service, and stops only that child process. It does not open a router port or change DNS. Each new quick tunnel can have a different URL; old links must be replaced. Quick tunnels have no uptime guarantee and can be unsuitable for production use. If cloudflared has an existing configuration that prevents quick tunnels, use a separate supported cloudflared configuration before retrying.

Live tunnel connectivity has been checked on this machine: the public upload page returned HTTP 200 and the owner API returned HTTP 401 remotely. Large transfers over an external mobile connection have not yet been tested. Local upload integrity and approvals are covered by the automated and browser tests. Do not rely on this version as your only copy of irreplaceable files.

## Large files, resume and storage

- File bytes are sent sequentially in 4 MiB chunks, with a maximum of four server-side upload operations in flight.
- The server stores progress in SQLite and flushes local chunks to disk before acknowledging them. Duplicate offsets return the current position rather than appending twice.
- Keep the browser page open. After interruption, reselect the **same original files in the same browser session/origin**. Matching path, size and modification time resumes the saved upload ID. A changed browser, guest session or tunnel origin may require starting again.
- Local partial files live in `data/partial`. Completion copies into the selected inbox, flushes the result, records a SHA-256 digest, then deletes the partial. This supports inboxes on a different Windows drive, at the cost of an extra disk copy and conservative free-space reservation.
- A local receipt means the final file size was checked and a SHA-256 digest recorded. This is not an independent backup or proof against a malicious uploader.
- Local files are grouped as `inbox/<request-or-personal>/<batch>/<original-relative-path>`. Existing files are never overwritten. Empty directories are not represented by browser folder selection.
- Pending uploads continue to reserve allowance until cancelled or completed. Cancel partials in Recent files to reclaim local staging space.
- Completed files are managed directly in the inbox. The initial UI does not rename, delete or preview them. Click a completed local file name in Recent files to download it.
- There is no background camera-roll sync, malware scanner, replication, automatic partial retention policy, or end-to-end encryption in this release. Uploads are never executed by Setu and previews are disabled; treat received files as untrusted before opening them.

## Credentials, local data and recovery

On Windows the owner key and token-encryption key are protected with **DPAPI CurrentUser** in `data/secrets.dpapi`. Invitation and guest tokens are stored as hashes. Owner sessions are in memory. Logs avoid tokens, request bodies and signed URLs.

On other operating systems `data/secrets.json` uses filesystem permissions instead of DPAPI. This initial version is primarily intended for Windows. Protect the full data directory with your OS account permissions. DPAPI does not protect against malware already running as your Windows user. Filenames, emails and activity metadata remain plaintext in SQLite.

Back up your actual inbox separately. To back up Setu metadata consistently, stop the app and copy the complete `data` directory. Windows DPAPI credentials are tied to the Windows user/profile: copying them to another machine is not a portable recovery strategy. Existing local files remain ordinary files and are independently recoverable, but the new dashboard will not automatically import old records.

`.env`, `data`, `inbox`, and `test-results` are ignored by Git. Invitation secrets are shown only once and are not recoverable from the server. Create a new link if one is lost. File transfers should remain private; there is no public signup or public library.

## Development and validation

```powershell
npm run check
npm test
```

The automated suite exercises local approval boundaries, revoked/expired links, file quotas, offset recovery across restart, path validation, encrypted-token integrity, empty files, cancellations, owner-only downloads and byte-for-byte upload integrity. Tests use temporary directories and no cloud accounts.

`scripts/ui-server.js` and `scripts/ui-smoke.py` provide an optional browser test fixture on port 4784, requiring Python Playwright and Microsoft Edge. They cover owner uploads, guest request/approval/upload, mobile overflow and JavaScript errors; screenshots are written under `test-results`. Those development tools are not needed to run the Setu application.

Setu is a new lightweight implementation inspired by the storage-routing idea in [9drive](https://github.com/zenhosta/9drive). It does not run or copy 9drive's backend and does not inherit its public-write upload behavior.
