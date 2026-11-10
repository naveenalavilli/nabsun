# Task benchmark

Run `npm run build`, then `npm run bench -- --provider=scripted` or `--provider=local`.
The local backend requires the existing bundled engine and weights. No paid backend
is called implicitly. Fixtures run only on two loopback ports, without live websites.
React 19.3.1 is bundled into the controlled-input fixture from development dependencies.

There are 36 workflow tasks (12 categories, three variants) plus a trusted-input probe.
Every task is attempted three times in a fresh document and conversation. The scripted
provider reads the same page outlines and emits the same tool calls as a model. It
cannot inspect or modify the fixture DOM directly. Success is checked independently
against fixture results, not the assistant's prose or a successful tool return.
All calls use the real Agent and shared approval gate in an isolated temporary profile.
The fixture auto-approval setting is confined to that temporary profile.

JSON and Markdown reports in `bench-results/` include per-attempt success, tool steps,
usage reported by the provider, wall time and dispatch tier. Scripted usage is zero,
not an estimated model score. These results measure the browser action layer; the
nightly local model run measures planning as well. A scripted regression fails by
comparing each task's success rate with `scripted-baseline.json`; improvements pass.
A missing target or unimplemented tool is a failure, never an implicit skip.

Use `--task=plain-1 --attempts=1` for diagnosis. These shortened runs cannot replace a
baseline. `--record-baseline` requires all 111 scripted attempts and regenerates the
reviewed JSON and Markdown together. Update the baseline only after review; retaining
the original baseline makes improvement visible. `--output=docs/bench/local.json`
generates a model table into the repository after an actual model run. Do not hand-edit
success figures. Raw reports must accompany any claim of a model quality improvement.

The sign-in category measures a trusted human-style sign-in entry control; it does not
certify basic/NTLM/proxy authentication (N-06). The separate network harness checks HTTP
Basic authentication. Upload fixtures attach a file through the chat-owned file-id API.
Drag tests require an actual trusted HTML drop.

The original measurement is preserved as `scripted-before-improvements.json` and its
generated table: 63/111. After trusted input, frame routing, and file capabilities, two
full fixture runs reached 111/111. The CI baseline now requires that result for every
task. These are scripted tool-reliability scores, not model-quality scores.
The fresh full-regression run is archived in `scripted-verified-current.json`,
including runtime metadata and all 111 successful attempts.

`local-planner-diagnostic.json` preserves an interrupted real-model diagnostic on
version 1.0.0 at four CPU threads and an 8,192-token context. Both completed
plain-form attempts failed with malformed element references (about 71 and 180
seconds). Only two of the expected 111 attempts completed before the run was
stopped to tighten fixture network isolation. This is evidence of an unresolved
planning problem, not a complete model baseline or a model comparison. A passing
local inference smoke test does not supersede these failed task attempts.
