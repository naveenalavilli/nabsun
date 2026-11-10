# 1.0 improvement-plan verification record

Source: `review-docs/improvementPlan.md` in the parent workspace. No work item is
complete until every acceptance check and the cross-platform gates have evidence.
This is an implementation and evidence ledger, not a claim that the roadmap has shipped.

User decisions: version 1.0.0; revoke existing global grants in favor of scoped,
expiring approvals (recommendation explicitly accepted). Signing-account setup is
deferred until the final release stage. Installer packaging and licensing review
are also deferred while the implementation branch is reviewed. Other security defaults recommended for implementation
following the request for our recommendation: revoke old global grants with a migration
notice; hash typed values in the audit journal; no assistant or journal in private windows.
No analytics or crash upload is introduced. Signing requires owner credentials and is
not satisfied by an ad-hoc signature. Performance targets remain unset until measurement.

| Item | State | Evidence / remaining gate |
| --- | --- | --- |
| N-01 benchmark | In progress | 37 local tasks, three attempts; original scripted 63/111 archived, two full improved runs 111/111. CI baseline raised to require 111/111. JSON/tables generated from actual runs. Scripted CI and nightly local-model workflow added; remote execution and full model benchmark pending. |
| N-02 signing/update | Not complete | Owner signing identities, verified installer/update/tamper exercise and package-size evidence required. Existing 0.1.x cannot acquire automatic installation without a manual bootstrap upgrade. |
| N-03 trusted input | In progress | Trusted keyboard/mouse, Unicode, double/right-click, select, checkbox, covered-target, credential refusal and Stop fixtures pass. Newlines in single-line fields reject before input. Date/time and multi-select compatibility fallbacks are explicit. Cross-platform gate and demos pending. |
| N-04 frames/shadow DOM | In progress | Cross-origin and separate-process iframe fill/submit, hidden frames, stale-frame refusal, open shadow roots and credential redaction fixtures pass. Broader nested-frame coverage and cross-platform evidence pending. |
| N-05 files | In progress | Chat-owned IDs, bounded worker text/CSV/XLSX/PDF reads, native upload and separately approved submit, hash tamper refusal, same-run download reads and unrelated download exclusion pass. Chat image previews and automatic delivery of up to four images to vision models implemented; additional images available through file_read. Text-only model warning, malformed-image refusal, persistence, removal and cross-chat isolation tests pass. Cross-platform/package gates pending. |
| N-06 sign-in/permissions | In progress | User-only native permission prompts and site settings implemented. Camera fixture, remembered denial reconstruction, revocation and cross-origin refusal pass. HTTP Basic fixture passes through a separate sandboxed credential dialog. System/direct/manual/PAC configuration and integrated-domain validation pass. Client-certificate picker implemented; NTLM/proxy-auth/client-certificate fixtures and actual restart checks outstanding. |
| N-07 data/batch | In progress | CSV/XLSX/paste workspace, row budgets and durable checkpoints implemented. Hard-killed separate Electron after durable row 20; restart completes 21–50 with exactly 50 server submissions. CLI model batches explicitly unavailable until delegated host budgets exist. |
| N-08 record/replay | In progress | Versioned import/export/edit/variables and command palette implemented. 50-row matching replay uses zero model calls; label drift uses one validated repair, then reuses it. Failed postcondition halts before next row. Upload replay, wider schema/repair evaluation and demos pending. |
| N-09 run report | In progress | CSV/JSON entries match 50 independently observed server submissions. Needs-review results retain failure screenshots and require explicit reconciliation. Cross-platform and UI/export limit gates pending. |
| N-10 approvals/policy | In progress | Old global grants revoked with notice; once/task+origin/24-hour site grants, expiry, revoke, Stop and origin-bound autopilot fixtures pass. Shared policy checked before approval and dispatch; target details/highlight and forced upload/eval/cross-origin-submit prompts implemented. Broader MCP/race regression pending. |
| N-11 audit | In progress | Shared action path records durable hashed intent/results and approval source. Hash-chain, removed-final-record, partial-write, live tamper, retention-anchor and fail-closed storage fixtures pass. Full activity workspace, date/filter/export and user-entered nabsun://activity entry implemented; workspace UI passes. Complete denial/cancellation and concurrency review, export edge cases and cross-platform gates outstanding. |
| N-12 integration lockdown | In progress | Production plugins run in a separate permission-restricted Node host. Profile reads, source writes, child processes, symlinks and hardlinks are refused in fixtures. Exact plugin and MCP source pins require native review after changes. MCP children inherit an explicit environment allowlist, and Stop terminates their process trees. Independent plugin/MCP/extension switches are enforced through shared policy. These are process and filesystem restrictions, not a complete OS network sandbox. Cross-platform/package review remains outstanding. |
| N-13 routing/budgets | In progress | Hosted CLI streams now receive temporary host-issued browser capabilities bound to the exact chat/run. Delegated calls use shared approval, audit and per-action transcript persistence; default CLI limits are 100 browser actions and five minutes. Action-budget refusal, Stop during approval, task completion revocation and idle timeout fixtures pass. Reported token use is bounded, but unreported CLI-internal token use cannot be strictly enforced. Constrained grounding, measurable tier/token results, journaled escalation and wider concurrency tests remain outstanding. |
| N-14 model decision | Not complete | Actual candidate measurements, licence checks, laptop RAM/latency evidence and decision memo required. No model winner is assumed. |
| N-15 profiles/private | Not complete | Isolated stores/partitions and no private disk activity tests required. |
| N-16 distribution/Linux | Not complete | Slim/full packages, verified resumable model transfer, size evidence and Linux full-suite checks required. |

Release is not certified while any required gate remains open. A release note or version
number is not evidence of a signed installer, a model performance score, a smaller package,
a private-mode guarantee, or a passing macOS/Linux test.

## Chat dictation

The microphone button uses the installed Windows desktop speech recognizer,
without a new account, an audio upload, or an additional model download.
Each recording asks for explicit consent and lasts at most one minute. Recognized
phrases appear in the current draft; users review the words and press Send.
The microphone button, Escape, changing chats, hiding the chat, minimizing or
closing its window stop dictation. Late recognizer output cannot change another
chat's draft. Windows microphone access and a working default input device are
required. Languages are limited to installed Windows speech recognizers; restart
Nabsun after installing another speech language.

macOS and Linux currently show system dictation guidance instead of starting an
in-app recorder. On Mac, enable Dictation in System Settings > Keyboard and use
the microphone key or the configured shortcut while the message box is focused.
On Windows without a desktop recognizer, the fallback is Windows+H. These OS
features have their own language support and privacy settings.

Evidence: voice-manager consent, ownership, cancellation, Unicode and missing-language
fixtures pass; the real Windows recognizer discovery found en-US. A generated
English speech WAV was transcribed as “Hello this is a test message for the browser”
by the real installed engine. The assistant UI fixture verifies multilingual draft
insertion, no automatic send, Stop and late-output rejection. Live microphone
quality and macOS/Linux user dictation remain manual checks.

Implementation references: Microsoft's [desktop recognition API](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine.recognize?view=netframework-4.8)
and Apple's [Dictation instructions](https://support.apple.com/en-gb/guide/mac-help/mh40584/26/mac/26).

## Regression review: 2026-11-10

The Windows full-suite run reached network configuration after passing the earlier
test groups, including all 111 scripted benchmark attempts. It exposed an
intermittent empty PAC resolution. A stronger regression also demonstrated that
reapplying an unchanged PAC URL used stale script contents. The old implementation
fails that regression; closing old connections before changing configuration and
explicitly reloading PAC configuration passes three delayed-fetch/update cycles.

Review also fixed active-chat deletion: deletion cancels runs owned by the chat,
and late callbacks cannot recreate its history. The UI fixture verifies a genuinely
running turn is cancelled, and both late upsert and best-effort append are refused.
An upload fixture's immediate server assertion raced the page's asynchronous
fetch; it now waits for the independently observed server content without
retrying the submission.

Validation coverage across the initial run and successful affected-test reruns:

- Build, TypeScript, payload checks, CLI/account connections, onboarding/settings,
  browsing/page tools, agent execution, MCP, delegation and local inference.
- Fresh scripted benchmark: **111/111**, compared with **63/111** in the original
  measurement. The current raw report is `bench/scripted-verified-current.json`.
- Trusted input, frames, files/images, dictation, 50-row workflow replay, hard-kill
  recovery, reports, approval scopes, journal integrity, permissions and network.
- Integration source approval, environment filtering, plugin process restrictions,
  process-tree cancellation and kill switches.
- Dependency audit: zero reported vulnerabilities. `git diff --check` passes.
- Windows unpacked packaging, exclusion of test harnesses, required unpacked
  workers, actual packaged XLSX/PDF parsing, and engine/model/licence payload check.
- macOS permission descriptions and camera/audio entitlements parse correctly.
  A packaged Mac device check has not been performed here.

This is aggregate coverage, not a claim that the original `npm run verify`
invocation exited successfully: it stopped at the PAC failure. The network fix,
remaining integration group, and affected UI/file/delegation/agent paths were
then tested successfully. Logs are retained in the parent `.review-artifacts`
directory (`full-regression-current.log`, `network-fixed.log`,
`integrations-regression-current.log`, `assistant-deletion-current.log`,
`post-review-checks.log`, `final-review-targeted.log`, and
`packaged-payload-current.log`).

The action layer is measurably stronger, and matching workflow replay completes
without model calls. This does not establish reliable general-purpose planning:
the bundled-model diagnostic failures remain unresolved. Signing/notarization,
automatic update installation, model evaluation/routing, profiles/private mode,
slim distribution, and complete macOS/Linux release verification are still open.
Version 1.0.0 is **not release-certified**.

### Final local pass before branch push

After the fixes, a new complete `npm run verify` invocation exited successfully
on Windows (`.review-artifacts/full-regression-final.log` in the parent workspace).
This includes the fresh 111/111 benchmark, workflow crash recovery, attachment
and dictation checks, deleted-chat lifecycle, PAC refresh, and the integration
isolation group. TypeScript and staged whitespace checks also pass. The earlier
failed run remains documented above as the provenance of the regression fixes.
Remote Actions results must be checked against the pushed commit before calling
the branch's cross-platform CI green.
