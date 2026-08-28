# Release Acceptance Record

This record is the gate for the two-step UmaAgent release. It must be updated with
the actual remote commit, CI run URLs, production backup checksums, and operator
sign-off before a release is declared complete.

## R1 local baseline

- Candidate commit: record the final release commit after the last verified build.
- Protocol: `v14`; database schema: `20`.
- `npm run check`: passed.
- `npm run build`: passed.
- `npm test`: passed (255 tests).
- `npm run test:coverage`: required before release tagging.
- Android `test lint assembleDebug`: passed locally with API 35 and JDK 17.
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`.
- APK SHA-256: record after the final build.
- Legacy-channel scan: run the repository forbidden-term scan while excluding
  `.git`, dependency caches, and build caches; the result must be empty.

## R1 device checks

- [ ] PAT login succeeds and survives process restart through Android Keystore.
- [ ] Session list, snapshot, history, message send, and streaming updates match Web.
- [ ] Duplicate, out-of-order, and missing sequence events recover without rollback.
- [ ] Offline mode serves cached reads and disables every write action.
- [ ] Network recovery reconnects and fills the event gap without duplicate messages.
- [ ] Xianyu unlock and status query succeed; Grant is cleared on logout, expiry, and restart.

## Production operator gate

Production actions require root/systemd access and the real Xianyu secrets. The
operator must attach the following evidence:

- [ ] Release verifier output and `systemd-analyze verify` output.
- [ ] SQLite, telemetry, workspace, Xianyu state, and config backup checksums.
- [ ] Restore/integrity check output showing schema `20` and no foreign-key violations.
- [ ] Inventory and archive record for every removed legacy service, volume, state, and log path.
- [ ] Core, Browser Worker, and Xianyu Adapter systemd status after promotion.
- [ ] Core live/ready, Adapter health, and Core-proxied Xianyu status responses.
- [ ] Web and CLI smoke results for login, unlock, status, lifecycle, history, item, chat, and publish.
- [ ] Rollback rehearsal result, including all three active services and release pointer.

## R2 completion

- [ ] Session/run controls, attachments, approvals, resources, and Xianyu console are complete.
- [ ] TypeScript and Kotlin consume the same v14 fixtures and contract tests pass.
- [ ] API 35 emulator instrumented tests pass for lifecycle, rotation, background, and offline recovery.
- [ ] No new migration, compatibility layer, fallback, or legacy field was introduced.
- [ ] 24-hour post-release observation has no unresolved release-blocking errors.
