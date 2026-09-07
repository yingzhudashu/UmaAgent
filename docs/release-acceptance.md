# Release Acceptance Record

This record is the gate for the two-step UmaAgent release. It must be updated with
the actual remote commit, CI run URLs, production backup checksums, and operator
sign-off before a release is declared complete.

## Xianyu status-tool preflight hotfix (2026-09-08)

- Core release `20260908022600-0a85f01` is live from commit `0a85f01a8610c29f095523affb726dad472d3450`; protocol is `15` and schema is `23`.
- `npm run check`, `npm test` (53 files, 287 tests), and `npm run build` passed before promotion. The release verifier passed on the server.
- Production backup is `/srv/backups/uma-agent/state-20260907182458.db`; the promote gate preserved the protected administrator fingerprint and atomically switched `current`.
- The Xianyu control session now bypasses generic clarification preflight for `agent` requests and enters the channel tool set. A live administrator smoke test completed with `xianyu_status`, reporting Adapter `connected=true`, login `authenticated`, and a completed natural-language response.
- `uma-agent.service`, `uma-browser-worker.service`, `uma-xianyu-adapter.service`, `robotclaw.service`, and `nginx.service` are active; Core live/ready both returned HTTP 200.
- The protected PAT file was normalized from CRLF to LF without changing its token value and remains `root:root 0600`. Temporary administrator probe tokens were deleted in `finally` blocks.

## Current Xianyu workspace release (2026-09-07)

- Core release `20260907145346-3ecf056` and Web embed release `20260907145402-3ecf056` are live from commit `3ecf0560bb6d3958a4c31fd7998bf87a4c63a7a6`; protocol is `15` and schema is `23`.
- `npm run check`, `npm test` (53 files, 285 tests), `npm run build`, `npm run build:web:embed`, and Web E2E (5 tests) passed locally and in the release gate.
- Android production release `7-3ecf056` is version `1.2.0`, versionCode `7`, signed with the recovered production keystore, and published only after manifest size/SHA-256 verification. APK SHA-256 is `b29bb89e0b52364a5f93fb9ddb5a08d158c45839b5d37e95b8a690f51886010d`.
- v22 to v23 migration preserved the production database; `PRAGMA integrity_check` is `ok`, foreign-key violations are zero, and the production state backup is `/srv/backups/uma-agent/state-20260907145352.db`.
- Core live/ready, Web entry points, Core/Web embed hashes, Android manifest, and all UmaAgent-related services passed post-release checks. Xianyu Adapter reports `authenticated/connected`; its Cookie file remains mode `0600`.
- The general systemd gate reported the pre-existing independent `ai-knowledge-health.service` failure because the production knowledge snapshot trails staging by 41.7 hours. The UmaAgent production verifier now scopes failures to the services owned by this release; the AIKB freshness issue remains an operational follow-up and was not cleared by this release.

## Current mobile hotfix status (2026-09-06)

- The Android login failure was traced to parameterless JSON requests being sent with `Content-Type: application/json` and a zero-byte body. The shared request layer now sends `{}` for empty `POST`/`PUT`/`PATCH` requests.
- Android JVM tests passed: `:app:testDebugUnitTest`, 37 tests.
- Local Debug APK assembly passed: `:app:assembleDebug`; SHA-256 was `ED0BFA1A1AB6CE4F82B5C533173E8BBE731E86B2A2082AC2BA982317AEC9C48`.
- The original release keystore was recovered at `C:\Users\16785\.umaagent\android-release.jks`; its certificate matches the production certificate `86d57c047055e3923c753a0a7abc10e493894b94072798c3865e275e1ffc506d`.
- Signed release publication completed from commit `74e75dfc2fc5d3a7e95f834e1155152fa5514736` as release `5-74e75df`, Android `versionCode 5`, `versionName 1.1.3`.
- Published APK SHA-256 is `e9939c2b626491cc5bcf80e042bbf8b8c02992cbe6e3f0cad6c2e8b1177d6c41`, size `7571849` bytes. Public manifest and APK download matched these values; Core live returned HTTP 200.

## Current Android UI release (2026-09-07)

- Signed release publication completed from commit `17518d92a95a572efc5060a9bac2e734e02d2dc6` as release `6-17518d9`, Android `versionCode 6`, `versionName 1.1.4`.
- The release uses the existing production certificate `86d57c047055e3923c753a0a7abc10e493894b94072798c3865e275e1ffc506d`; it matches the previously published APK and remains upgrade-compatible.
- APK SHA-256 is `14f683ee3109dea0bcf6ab750feb96a47e5e5d60ecfdcbbc9e1c6318f9397914`, size `7604617` bytes. The public manifest and downloaded APK matched these values.
- `current` was atomically switched to `/srv/www/robotclaw/app/releases/6-17518d9`; the previous `5-74e75df` directory remains available for rollback.
- Release notes cover response aggregation and collapsed execution details, improved mobile reading, message retry, and the Xianyu QR login console.

## Previous managed Xianyu production release (superseded, 2026-09-07)

- UmaAgent release `20260906182720-032a419` was promoted from commit `032a419ff9e97e6b3d36e4e3f9710673a37b0f55`; protocol was `15` and schema was `22`.
- `npm run check`, `npm run build`, `npm run build:web:embed`, and `npm test` passed locally. The final test run passed 53 files and 284 tests.
- The release verifier passed before promotion. A protected production state backup was created at `/srv/backups/uma-agent/state-20260906182726.db`.
- `uma-agent.service`, `uma-browser-worker.service`, `uma-xianyu-adapter.service`, `robotclaw.service`, and `nginx.service` are active; staging UmaAgent units remain disabled.
- Core live and ready both returned HTTP 200. The Adapter control health endpoint returned `status=stopped` with `login.status=pending_login`, which is expected while the configured Cookie is empty.
- A temporary, immediately revoked `system` administrator probe verified the pre-workspace administrator flow, QR generation, and login-status polling. This record is retained only as historical evidence; the password/Grant flow is no longer supported.
- A permanent `system` administrator console PAT was provisioned and verified for the operator; its value is intentionally omitted from repository and operational records.
- The QR session naturally expired during the acceptance window; the Adapter then reported `login.status=expired` and remained stopped while its systemd unit stayed healthy. The actual administrator scan remains pending. Cookie persistence, authenticated Adapter recovery, account-auth-expiration stop behavior, and Feishu alert delivery therefore remain operational follow-up checks rather than completed acceptance claims.

## R1 local baseline

- Candidate commit: `74e75dfc2fc5d3a7e95f834e1155152fa5514736` (`fix: repair Android bootstrap JSON requests`).
- Protocol: `v15`; database schema: `22`.
- `npm run check`: passed.
- `npm run build`: passed.
- `npm test`: passed (record the final test count from the release run).
- Android `:app:testDebugUnitTest` and `:app:assembleDebug`: passed locally with SDK/target API 35 and JDK 17; instrumented device tests remain pending.
- APK: `C:\Users\16785\AppData\Local\Temp\UmaAgent-1.1.3-5-74e75df\UmaAgent-1.1.3.apk`.
- APK SHA-256: `e9939c2b626491cc5bcf80e042bbf8b8c02992cbe6e3f0cad6c2e8b1177d6c41`.
- Release APK signing certificate: `86d57c047055e3923c753a0a7abc10e493894b94072798c3865e275e1ffc506d`, matching the previously published APK.
- Legacy-channel scan: run the repository forbidden-term scan while excluding
  `.git`, dependency caches, and build caches; the result must be empty.

## Latest hosted CI evidence

- Hosted CI evidence is pending publication of the reviewed working tree.
- Local Node, Web paste-image E2E, Android JVM tests, APK assembly, and instrumented-test
  compilation are the current evidence; device execution is still required.

## R1 device checks

- [ ] PAT login succeeds and survives process restart through Android Keystore.
- [ ] Session list, snapshot, history, message send, image attachments, and streaming updates match Web.
- [ ] Duplicate, out-of-order, and missing sequence events recover without rollback.
- [ ] Offline mode serves cached reads and disables every write action.
- [ ] Network recovery reconnects and fills the event gap without duplicate messages.
- [ ] Core administrator PAT enters the Xianyu workspace; status and QR login succeed without a client password or Grant.

## Production operator gate

Production actions require root/systemd access and the real Xianyu secrets. The
operator must attach the following evidence:

- [ ] Release verifier output and `systemd-analyze verify` output.
- [x] SQLite, telemetry, workspace, Xianyu state (absent and recorded), and config backup checksums.
- [ ] Restore/integrity check output showing schema `23` and no foreign-key violations; v22-to-v23 migration preserves users, tokens, sessions, and messages.
- [x] Inventory and archive record for removed legacy services, state, and environment files.
- [x] Core, Browser Worker, and Xianyu Adapter systemd status after promotion.
- [x] Core live/ready, Adapter health, and Core-proxied Xianyu status responses.
- [ ] Web, CLI, and Android smoke results for PAT login, workspace, status, lifecycle, history, item, chat, publish, and draft send.
- [ ] First-login QR generation with an empty configured Cookie and administrator PAT.
- [ ] Actual first-login scan, atomic `0600` Cookie persistence, and automatic Adapter recovery.
- [ ] Expired-login stop behavior and Feishu alert delivery, or an explicit record that the three Feishu credentials are not configured.
- [ ] Rollback rehearsal result, including all three active services and release pointer.
- [x] Original Android release keystore is available; release APK certificate matches the currently published package.
- [x] Android APK release directory, `latest.json`, `releases.json`, and `current` symlink were switched atomically and publicly verified.

Production backup stamp: `20260906182726`; retired channel archive is under
`/srv/backups/uma-agent/retired-channel-20260828014500`.
The Xianyu Adapter is enabled with the real internal control token and Feishu alert
configuration. The configured Cookie is intentionally empty pending the first
administrator QR scan; no client password, Grant, or placeholder secret is used.

## R2 completion

- [ ] Session/run controls, image attachments, approvals, resources, and Xianyu workspace are complete.
- [ ] TypeScript and Kotlin consume the same v15 fixtures and contract tests pass.
- [ ] API 35 emulator instrumented tests pass for lifecycle, rotation, background, and offline recovery.
- [ ] No new migration, compatibility layer, fallback, or legacy field was introduced.
- [ ] 24-hour post-release observation has no unresolved release-blocking errors.
