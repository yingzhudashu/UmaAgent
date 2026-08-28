# Release Acceptance Record

This record is the gate for the two-step UmaAgent release. It must be updated with
the actual remote commit, CI run URLs, production backup checksums, and operator
sign-off before a release is declared complete.

## R1 local baseline

- Candidate commit: `003539d` (local; `origin/master` remains `fcd9069` until network push succeeds).
- Protocol: `v14`; database schema: `20`.
- `npm run check`: passed.
- `npm run build`: passed.
- `npm test`: passed (255 tests).
- `npm run test:coverage`: passed, 255 tests; 84.42% lines, 81.93% statements.
- Android `test lint assembleDebug`: passed locally with API 35 and JDK 17.
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`.
- APK SHA-256: `9D6466D9BC917BBF31C407EE2AE31A2D01545F8590D91622DB7AA2F1DC7A4DF7`.
- Legacy-channel scan: run the repository forbidden-term scan while excluding
  `.git`, dependency caches, and build caches; the result must be empty.

## Latest hosted CI evidence

- Commit `fcd9069` is pushed to `origin/master` and triggered both workflows.
- Android run `33133640950` passed with JDK 17, SDK 35, tests, lint, and APK assembly.
- Node/Docker run `33133640982` failed during the core image build; `003539d` removes
  the unverified workspace prune step and must be pushed before CI can be re-run.
- The prior Docker failure was fixed by moving workspace import validation after
  TypeScript compilation and checking the generated protocol, telemetry, and core
  artifacts.

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
- [x] SQLite, telemetry, workspace, Xianyu state (absent and recorded), and config backup checksums.
- [x] Restore/integrity check output showing schema `20` and no foreign-key violations.
- [x] Inventory and archive record for removed legacy services, state, and environment files.
- [ ] Core, Browser Worker, and Xianyu Adapter systemd status after promotion.
- [ ] Core live/ready, Adapter health, and Core-proxied Xianyu status responses.
- [ ] Web and CLI smoke results for login, unlock, status, lifecycle, history, item, chat, and publish.
- [ ] Rollback rehearsal result, including all three active services and release pointer.

Production backup stamp: `20260828013358`; retired channel archive is under
`/srv/backups/uma-agent/retired-channel-20260828014500`.
The Xianyu adapter remains disabled until real Cookie, control token, and scrypt
administrator hash are injected by the operator; no placeholder secret was used.

## R2 completion

- [ ] Session/run controls, attachments, approvals, resources, and Xianyu console are complete.
- [ ] TypeScript and Kotlin consume the same v14 fixtures and contract tests pass.
- [ ] API 35 emulator instrumented tests pass for lifecycle, rotation, background, and offline recovery.
- [ ] No new migration, compatibility layer, fallback, or legacy field was introduced.
- [ ] 24-hour post-release observation has no unresolved release-blocking errors.
