# Code-signing policy

Setu release artifacts are built from the tagged source tree in this
repository. Pull requests and the default branch run the Node.js checks and
tests through GitHub Actions. A release candidate is built on Windows from the
documented PowerShell build script, inspected, and manually approved before
signing.

The signing workflow must never receive user data, inbox files, owner keys,
SQLite databases, `.env` files, or tunnel credentials. Only source-built
release artifacts may be submitted for signing.

Free code signing provided by SignPath.io, certificate by SignPath Foundation.
