# Token efficiency plan

Status: parked at the user's request on 2026-11-14; research only, no runtime changes.
Reviewed 2026-11-14 against Nabsun 1.0.2, main `43e825a`.
Work branch: `enhancement/token-efficiency`.

## Recommendation

Start with deterministic context selection, structured action receipts, targeted
reading, and measured cache reuse. Then evaluate Jev as an optional selector or
router. Do not make a second cloud service mandatory, replace the main assistant,
or discard instructions to meet a token target.

Measure three separate outcomes: fewer tokens, lower total cost, and faster task
completion. Prompt caching can reduce cost and latency without reducing context
size. A cheaper model can reduce cost while increasing tokens and retries.

## Privacy discussion to resume

The user's latest clarification is that they want to prevent data leaks while
continuing to converse with cloud models. The proposed approach is controlled
cloud disclosure: minimum task context, local sensitive-data detection, protected
content private by default, and explicit task-scoped sharing. The exact categories
and approval experience remain undecided. This is not a decision to require local
models for every conversation. A cloud model necessarily receives submitted
content; compression, redaction, caching and no-training terms do not constitute
on-device processing. No new runtime privacy guarantee is implemented here.

Until that boundary is resolved, do not send user data to Jev, hosted compressors,
cloud shadow evaluations or new helper services. Use synthetic fixtures for
research. A shadow evaluator still discloses data even if its output is ignored.

Before implementation, inventory every model-bound channel: submitted prompts,
history, tab URLs/titles, attached pages, screenshots, uploads, browser and file
tool results, saved notes, summaries, error strings and CLI tool delegation.
Treat derived summaries and embeddings as user data too. Enforce the selected
boundary at both request serialization and tool-result return, including native
CLIs and external bridge clients; UI switches alone are insufficient. Provider
identity or a loopback URL alone cannot prove that downstream processing is local.

For strict on-device mode, block remote inference and remote fallback rather than
silently sending data. For an explicit-text-only cloud mode, exclude automatic
context and deny tools that would return protected content to the remote model.
That mode has reduced browser/file capabilities; show those limits clearly.
Neither policy changes the separate fact that visiting a website communicates
with that website. Verify model egress separately from normal browser traffic.

Add request-capture and bridge tests using distinctive synthetic secrets for all
channels, provider switches, retries, compaction, resumed CLI sessions and failure
paths. Verify that protected content never reaches forbidden destinations.

## What the current code does

| Area | Evidence | Implication |
| --- | --- | --- |
| Request construction | `src/main/ai/agent.ts`: `shapeRequest`, `pruneHistory`, `fitToContext` | There is already a common point for provider-neutral optimization. |
| Prompt and tools | `src/main/ai/prompt.ts`; `shapeRequest` | Stable system instructions; small-context models receive a shorter prompt and fewer tools. Hosted models generally receive the available catalogue. |
| History | `pruneHistory` | Older successful read observations are shortened to a 1,200-character excerpt plus notice. Earlier images are omitted. Instructions and action results remain. |
| Actions | `src/main/ai/tools/browser.ts` | Click/type/navigation results include fresh snapshots. These tool names are outside the read-observation allowlist, so their older snapshots are retained with their outcomes. |
| Claude API | `src/main/ai/providers/anthropic.ts` | Already sets automatic ephemeral caching and a system breakpoint, and records cache-read/write usage. Adding caching again is not a new optimization. |
| OpenAI-compatible API | `src/main/ai/providers/openai.ts` | Uses Chat Completions and reports cached input. Also shared with local servers; provider-specific options require capability checks. |
| CLI | `src/main/ai/providers/cli.ts` | Claude can resume a native session; Codex currently replays bounded history because its resume path cannot approve browser tool calls. Nabsun cannot fully control native context management. |
| Budget | `agent.ts` | Hosted input has a configurable estimated budget, default 24,000. Estimates use an ASCII/wide-character heuristic; images have a fixed allowance. This is not exact billing. |
| Long sessions | `agent.ts` | Hosted oversized context can still stop rather than lose instructions. Small local contexts may drop oldest exchanges while fitting. A verified working-state mechanism is needed before changing either behavior. |

The existing scripted benchmark measures browser/tool execution, not LLM planning
accuracy or billed tokens. Its 111/111 baseline must remain intact but cannot prove
that a compressor preserves model performance.

## Reproducible offline observations

Run `node scripts/measure-token-baseline.mjs`. It imports production shaping and
pruning, constructs only synthetic messages, and calls no model, website, or tool
handler. Results are archived in `bench/token-efficiency-baseline.json`.

| Core catalogue configuration | Tools | System estimate | Tool-spec estimate |
| --- | ---: | ---: | ---: |
| Hosted, text | 28 | 1,318 | 3,488 |
| Hosted, vision | 29 | 1,318 | 3,581 |
| Local 8k, text | 13 | 309 | 1,807 |

This excludes files, datasets, plugins and MCP. Tool-spec estimates include host
metadata; wire serializers differ. These are diagnostic estimates, not provider
token counts, user-traffic measurements, or achievable savings.

For an old synthetic 8,000-character result, current pruning reduces a
`browser_snapshot` result from 2,353 to 383 estimated text tokens. The same-size
`browser_click` and `browser_type` results remain at 2,353 each. That identifies a
testable opportunity; it does not establish that all action results can be trimmed
like read results. Their action outcomes must be preserved separately first.

## Options and tradeoffs

| Option | Fit for Nabsun | Decision |
| --- | --- | --- |
| Separate action receipts from page observations | Reduces repeated snapshots while keeping confirmed and uncertain outcomes | First implementation priority |
| Targeted DOM/file/table reads | Avoids sending irrelevant material in the first place | First implementation priority |
| Cache-aware context epochs | Keeps a stable prefix between deliberate compaction points | Measure and implement alongside context selection |
| Discoverable tool groups | Reduces large built-in/plugin/MCP catalogues without permanently hiding capabilities | Prototype after core context work |
| Verified task state and bounded summaries | Enables long sessions without retaining every observation | Implement after receipts and retrieval |
| Jev | Typed relevance/routing decisions, with a separate API and its own overhead | Optional experiment, shadow evaluation first |
| LLMLingua-2 | Learned token pruning; adds model/runtime and latency | Benchmark only if deterministic approaches leave a material gap |
| TOON / compact tables | Potentially useful for uniform rows; not a universal replacement for JSON or prose | Compare only on table-heavy fixtures |
| Provider-native compaction | Useful on supported APIs, not portable | Capability-gated adapter later |
| Cheaper model / reasoning routing | Can save money on bounded extraction and classification | Opt-in; preserve the main conversation model |
| Batch APIs | Unsuitable for an interactive browser action loop | Consider only for future offline jobs |

### Jev specifically

The user confirmed TypeSafe (https://typesafe.ai/) is the intended product.
Its model is named Jev; `optim-jev` is a separate reference integration, not the
product the user requested. TypeSafe describes Jev as a typed decision model, not a
conversational or code-generation replacement. Its choice/score outputs could
rank candidate observations or route a bounded request. They cannot produce the
assistant's normal response. See [TypeSafe introduction](https://docs.typesafe.ai/introduction)
and [coding-agent guidance](https://docs.typesafe.ai/introduction/coding-agents).

The [optim-jev project](https://github.com/Oqura-ai/optim-jev) implements stale-tool
pruning, routing, and skill selection for coding-agent integrations. Its documented
compaction is Claude Code specific; Codex compaction is unsupported. It requires
Python and a TypeSafe API key. It is a reference design, not a drop-in integration
for Nabsun's API providers. Its documented estimated savings are not Nabsun results.

Proposed experiment: rank only already-eligible old, read-only observations, using
sanitized metadata/excerpts. The host pins instructions, receipts and live context
before the judge runs. Relevance decisions are advisory. Low confidence, timeout,
unsupported configuration, or malformed output keeps the existing context. Cache
decisions by content hash plus task-state version; never reuse an old relevance
decision after the task changes. Limit latency and requests per compaction.

Jev experiments must obey the required privacy boundary above. Under strict
on-device processing, its hosted API cannot receive user content. An opt-in cannot
override that mode. No hosted calls or paid Jev experiment were made during this
review.

### Caching and native compaction

OpenAI documents stable-prefix reuse and cached-token reporting. Keep system text
and tool ordering stable, put changing context later, and measure actual cache
reads. Do not assume a custom compatible endpoint supports official cache controls.
See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

Claude already has caching enabled here. Its cache lifetimes, minimum prompt sizes,
and write charges mean shorter prompts or one-off requests do not automatically
benefit. Measure read/write/uncached usage rather than treating every cached token
as free. See [Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Current pruning changes an earlier result when it becomes old. That can invalidate
a reusable conversation prefix. Test pruning once at an explicit context epoch
versus pruning on each request; account for the larger retained context between
epochs. Adopt whichever lowers total task cost while fitting the model.

OpenAI's [native compaction](https://developers.openai.com/api/docs/guides/compaction)
uses the Responses API. Nabsun currently uses Chat Completions, so this needs a
separate supported adapter and opaque-state handling, not a flag added to all
compatible providers. Keep the current path available.

For alternatives, Microsoft's [LLMLingua](https://github.com/microsoft/LLMLingua)
offers learned prompt compression. Test CPU overhead, multilingual retention and
exact identifiers before adding another bundled model. [TOON](https://github.com/toon-format/toon)
offers a compact representation of structured data. Compare tokenizer counts and
answer accuracy against minified JSON/CSV on actual rows, including escaping,
nulls, nested values and formulas. Neither should transform safety instructions,
tool arguments, credentials, file hashes, or the audit record.

## Implementation sequence

### 1. Establish a real usage baseline

- Add an opt-in, local aggregate report per task/request: provider/model, system,
  tool-schema, history, live-observation and image estimates; actual input/output,
  cache reads/writes when reported; model/tool calls, retries and latency.
- Keep raw counts and estimates distinct. Store no prompt text, URLs, filenames,
  image bytes or secrets in this report. Missing CLI usage is unknown, not zero.
- Use model tokenizers/count endpoints where available; never call a paid service
  merely to count a routine request without making that cost explicit.
- Freeze task fixtures and model configuration before comparisons. Record cost
  with a versioned price table or actual invoice data; CLI subscription quotas
  cannot be converted reliably into per-token dollars.

### 2. Reduce unnecessary observations and calls

- Extend internal tool results with separate `receipt` and `observation` fields,
  preserving the existing rendered transcript and external tool contract. Keep
  success/failure/unknown status, affected target, revision and recovery details.
- Compact superseded observation portions of action results; never blindly add
  every write tool to the existing excerpt allowlist. Preserve whole tool pairs.
- Keep the newest relevant observation for each active tab/frame/document.
  Invalidate refs on page changes. Request a fresh snapshot when necessary.
- Avoid a second snapshot if an action already returned a valid fresh one.
  Do not cache a side-effecting call or reuse a stale page to avoid tokens.
- Prefer targeted text, semantic regions and table columns/ranges. Expose
  truncation/cursors and a way to retrieve omitted material. File/Office reads
  should select pages, paragraphs or cells rather than replay entire documents.
- Keep image details only while needed; later retain an attachment handle and
  source-backed findings, with a way to reread the image. Do not drop evidence
  still required for the current visual task.

### 3. Build retrievable task state and stable context epochs

- Preserve original transcripts and journals. Build a separate model-facing view:
  explicit user constraints, confirmed outcomes, unresolved questions, current
  work, source IDs, and next steps. Separate facts from uncertain interpretations.
- Derive action facts deterministically from receipts. Any model-generated summary
  references source records and must pass invariant checks before adoption.
- Compact only when projected savings exceed summary/retrieval cost, or context
  capacity requires it. Use high/low watermarks to avoid repeated compaction.
- Retain an epoch's prefix unchanged until the next accepted compaction. Do not
  mutate a native CLI's transcript externally or defeat its session lifecycle.
- Add scoped retrieval of omitted observations by opaque ID, honoring existing
  chat/folder/private-window boundaries and current file revision checks.
- Perform bounded recovery without repeating an uncertain send, purchase, delete
  or file write. Never reinstate the old implicit cumulative CLI token cap.

### 4. Reduce tool-catalogue overhead

- Keep essential navigation, reading, questions and discovery available. Advertise
  short capability groups; load exact schemas for the requested group in the next
  step. Track catalogue versions and preserve stable ordering within an epoch.
- Include group-discovery overhead and extra model calls in measurements. Handle
  mixed browser/file tasks, plugin reloads and unknown tools without dead ends.
- Every loaded tool still uses the same host approval, policy and audit gate.
  A selector cannot grant access or change an approval mode.

### 5. Evaluate optional selectors and routing

- Compare deterministic selection, Jev, LLMLingua-2 and a bounded summarizer on
  identical synthetic frozen traces. Any later user-data evaluation, including
  shadow mode, must satisfy the required privacy boundary first.
- Promote only with an explicit privacy choice and verified net savings including
  selector input, output, cache writes, retries, retrieval and latency.
- Route low-risk extraction/classification only after measuring fallback rates.
  Keep complex planning on the user's chosen model. Do not silently switch models
  or assume the bundled small model is a reliable summarizer.

## Verification and proposed acceptance gates

These are targets to validate, not claims of achieved savings:

- At least 25% lower median total input tokens across a fixed multi-step task set;
  report per-task and tail results so simple tasks cannot hide regressions.
- Lower total paid API cost after all helper calls, with separate cold/warm-cache
  and resumed-session runs. No >10% p95 completion-latency regression without an
  explicit tradeoff review.
- At least 30 attempts per representative task/configuration for model comparisons,
  using identical models and settings; report confidence intervals and failures.
  No more than a 2-percentage-point observed task-success drop, plus review of
  uncertainty: a small sample cannot certify non-inferiority by itself.
- Preserve the 111/111 scripted execution baseline, approval/journal behavior,
  Stop, prompt queue, attachments, frame refs, local-folder scope and Office
  revision/backup tests. Verify all provider serializers, image handling, CLI
  delegation and matched tool groups under long histories.
- Add recovery fixtures: changed user instructions, stale page refs, navigation,
  source retraction, multilingual text, interrupted writes, ambiguous results,
  selector failure, cache loss, model switch and private sessions.
- No lost user constraints or action receipts in deterministic checks; no duplicate
  irreversible action after compaction/restart. Any such failure blocks rollout.

Roll out behind an internal feature flag, then an optional "Use fewer AI tokens"
setting after evidence supports it. Keep full transcripts available and preserve
the existing path for rollback. Do not add token-saving prompts or extra routine
approval dialogs to the chat.

## Resume checklist

- Confirm the controlled-cloud disclosure policy and sensitive-data categories.
- Implement enforcement at model requests and tool-result/CLI bridge boundaries.
- Add local request accounting and structured action receipts before trimming
  older snapshots; preserve current refs and confirmed/uncertain outcomes.
- Run paired real-model benchmarks; the archived report is synthetic only.
- Evaluate TypeSafe Jev only if the deterministic baseline leaves a useful gap.
- Keep this work separate from installer signing; no release/version bump or
  runtime context changes have been made on this branch.

## Next concrete change when resumed

Resolve and enforce the privacy boundary before changing live model requests.
Then implement local request accounting and structured action-result separation.
Measure the snapshot opportunity above before introducing Jev or a compressor.
This research branch changes documentation and an offline diagnostic only; it
does not change permissions, runtime context, the selected model, or the version.
