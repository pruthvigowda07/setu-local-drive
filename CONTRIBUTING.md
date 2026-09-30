# Contributing to Setu

Setu is a local-first Windows file inbox. Contributions should keep received
files on the user's machine, preserve approval boundaries, and avoid logging
credentials or file contents.

## Development

Requirements:

- Windows for the desktop package
- Node.js 24 or newer
- Microsoft Edge WebView2 Runtime for the native window

Run the checks before opening a pull request:

```powershell
npm run check
npm test
```

The Windows package can be built with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1
```

Do not commit `data`, `inbox`, `dist`, `build`, `test-results`, `.env`,
SQLite databases, DPAPI secrets, or received files. Do not include personal
keys, tunnel URLs, or credentials in issues or pull requests.
