# Release Acceptance Record

This record is the gate for the two-step UmaAgent release. It must be updated with
the actual remote commit, CI run URLs, production backup checksums, and operator
sign-off before a release is declared complete.

## Current mobile hotfix status (2026-09-06)

- The Android login failure was traced to parameterless JSON requests being sent with `Content-Type: application/json` and a zero-byte body. The shared request layer now sends `{}` for empty `POST`/`PUT`/`PATCH` requests.
- Android JVM tests passed: `:app:testDebugUnitTest`, 37 tests.
- Local Debug APK assembly passed: `:app:assembleDebug`; SHA-256 was `ED0BFA1A1AB6CE4F82B5C533173E8BBE731E86B2A2082AC2BA982317AEC9C48`.
- This is source-level and local build evidence only. Production still serves Android `versionCode 4`, `versionName 1.1.2`, release `4-b54f787`; the fixed APK has not been published.
- Production publication is blocked until the original `CN=UmaAgent` release keystore is recovered. A Debug or newly generated signing key must not be used because installed production APKs would not accept the update.

## R1 local baseline

- Candidate commit: final reviewed commit (fill in the immutable release commit before promotion).
- Protocol: `v15`; database schema: `22`.
- `npm run check`: passed.
- `npm run build`: passed.
- `npm test`: passed (record the final test count from the release run).
- Android `:app:testDebugUnitTest` and `:app:assembleDebug`: passed locally with SDK/target API 35 and JDK 17; instrumented device tests remain pending.
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`.
- APK SHA-256: record the hash produced by the final Android build.
- Release APK signing certificate: compare with the current production APK before publication; do not accept a changed certificate.
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
- [ ] Xianyu unlock and status query succeed; Grant is cleared on logout, expiry, and restart.

## Production operator gate

Production actions require root/systemd access and the real Xianyu secrets. The
operator must attach the following evidence:

- [ ] Release verifier output and `systemd-analyze verify` output.
- [x] SQLite, telemetry, workspace, Xianyu state (absent and recorded), and config backup checksums.
- [ ] Restore/integrity check output showing schema `22` and no foreign-key violations.
- [x] Inventory and archive record for removed legacy services, state, and environment files.
- [ ] Core, Browser Worker, and Xianyu Adapter systemd status after promotion.
- [ ] Core live/ready, Adapter health, and Core-proxied Xianyu status responses.
- [ ] Web and CLI smoke results for login, unlock, status, lifecycle, history, item, chat, and publish.
- [ ] Rollback rehearsal result, including all three active services and release pointer.
- [ ] Original Android release keystore is available; release APK certificate matches the currently published package.
- [ ] Android APK release directory, `latest.json`, `releases.json`, and `current` symlink were switched atomically and publicly verified.

Production backup stamp: `20260828013358`; retired channel archive is under
`/srv/backups/uma-agent/retired-channel-20260828014500`.
The Xianyu adapter remains disabled until real Cookie, control token, and scrypt
administrator hash are injected by the operator; no placeholder secret was used.

## R2 completion

- [ ] Session/run controls, image attachments, approvals, resources, and Xianyu console are complete.
- [ ] TypeScript and Kotlin consume the same v15 fixtures and contract tests pass.
- [ ] API 35 emulator instrumented tests pass for lifecycle, rotation, background, and offline recovery.
- [ ] No new migration, compatibility layer, fallback, or legacy field was introduced.
- [ ] 24-hour post-release observation has no unresolved release-blocking errors.
