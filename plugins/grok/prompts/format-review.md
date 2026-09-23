Convert the review you just wrote into JSON matching the provided schema.

- Include every finding from your review, with the same severity, file, line range, confidence, explanation (as `body`), and recommendation. Do not drop, merge, or soften findings.
- `verdict` is the verdict from your review's first line. `summary` is your ship/no-ship summary. `next_steps` are your next steps.
- Do not investigate further and do not call any tools. Use only what is already in your review.
- If your review has no findings, return an empty `findings` array.
