# Third-party notices

Nabsun redistributes the following works. Their licences are permissive,
which is why they were chosen — but permissive is not the same as unconditional,
and each requires that its copyright and licence notice travel with any copy.
This file is that notice, and it must be included in any redistribution,
including a fork.

---

## llama.cpp

- **Upstream:** https://github.com/ggml-org/llama.cpp
- **Version:** `b10867` (native Windows and macOS builds)
- **Licence:** MIT
- **Copyright:** © 2023-present Georgi Gerganov and llama.cpp contributors
- **How it is used:** the `llama-server` executable and its `ggml` libraries are
  bundled unmodified and run as a child process to serve the built-in model.

The MIT licence permits redistribution provided the copyright notice and the
permission notice accompany the software. The full text ships in the release
archive and is retained in `vendor/llama/`.

---

## Qwen3-1.7B (GGUF, Q4_K_M)

- **Upstream:** https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF
- **Base model:** https://huggingface.co/Qwen/Qwen3-1.7B
- **Licence:** Apache License 2.0
- **Copyright:** © the Qwen team, Alibaba Cloud
- **How it is used:** the quantised weights are bundled unmodified as the
  default local model. They are not fine-tuned, retrained or otherwise altered.

Apache 2.0 permits redistribution and modification, including inside a larger
work under a different licence, on the conditions that the licence text and
copyright notice are retained, and that modified files are marked as changed.
The weights are unmodified. `vendor/models/MODEL-LICENSE.txt` is written
alongside them by `npm run fetch:model` so the attribution stays with the file
even if it is copied out of the application.

**Why this model.** A licence permitting redistribution was a hard requirement,
not a preference, and Apache 2.0 is unambiguous about it. Research-only and
non-commercial licences are not uniformly prohibitive — what they permit varies
per licence, and some allow redistribution under conditions — but each would
need reading and a judgement call, and several restrict exactly the case here:
bundling weights inside a redistributed application. Checking a model card's
licence before its evaluation numbers saves discovering this later.

---

## Nabsun itself

MIT — see [LICENSE](LICENSE). Bundling the works above does not change that,
since neither MIT nor Apache 2.0 is copyleft. Apache 2.0's patent grant and
notice requirements apply to the bundled weights, not to Nabsun's own
source.

Nothing here is legal advice. If you redistribute a build, satisfy yourself that
the notices above are present and correct in what you ship.
