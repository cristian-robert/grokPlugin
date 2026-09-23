// @ts-check
import crypto from "node:crypto";

const SEVERITIES = ["critical", "high", "medium", "low"];

/**
 * @typedef {{ severity: "critical" | "high" | "medium" | "low", title: string, body: string, file: string, line_start: number, line_end: number, confidence: number, recommendation: string }} Finding
 * @typedef {{ verdict: "approve" | "needs-attention", summary: string, findings: Finding[], next_steps: string[] }} Review
 * @typedef {{ model: string, target: string, sandbox: string, integrity: string, isolation: string, truncated: boolean, sessionId: string | null }} RenderMeta
 */

/**
 * Hand-rolled check of the review schema (zero dependencies). `--json-schema` constrains
 * Grok's output, but we still never trust it blindly.
 * @param {unknown} value
 * @returns {string[]} problems; empty when valid
 */
export function validateReview(value) {
  /** @type {string[]} */
  const problems = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["review is not an object"];
  }
  const review = /** @type {Record<string, unknown>} */ (value);
  if (review.verdict !== "approve" && review.verdict !== "needs-attention") {
    problems.push("verdict must be approve or needs-attention");
  }
  if (typeof review.summary !== "string" || !review.summary.trim()) {
    problems.push("summary must be a non-empty string");
  }
  if (!Array.isArray(review.next_steps) || review.next_steps.some((step) => typeof step !== "string")) {
    problems.push("next_steps must be an array of strings");
  }
  if (!Array.isArray(review.findings)) {
    problems.push("findings must be an array");
    return problems;
  }
  review.findings.forEach((raw, index) => {
    const finding = /** @type {Record<string, unknown>} */ (raw ?? {});
    const where = `findings[${index}]`;
    if (typeof finding.severity !== "string" || !SEVERITIES.includes(finding.severity)) {
      problems.push(`${where}.severity is invalid`);
    }
    for (const key of ["title", "body", "file", "recommendation"]) {
      if (typeof finding[key] !== "string") {
        problems.push(`${where}.${key} must be a string`);
      }
    }
    for (const key of ["line_start", "line_end"]) {
      if (!Number.isInteger(finding[key]) || /** @type {number} */ (finding[key]) < 1) {
        problems.push(`${where}.${key} must be a positive integer`);
      }
    }
    if (typeof finding.confidence !== "number" || finding.confidence < 0 || finding.confidence > 1) {
      problems.push(`${where}.confidence must be between 0 and 1`);
    }
  });
  return problems;
}

/**
 * Single-pass substitution so placeholders inside focus text or repo content are never expanded.
 * @param {string} template
 * @param {Record<string, string>} values
 */
export function fillTemplate(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => (key in values ? values[key] : match));
}

/**
 * Wraps untrusted repository content in a boundary the content cannot predict or close.
 * @param {string} content
 * @param {string} [nonce]
 */
export function wrapUntrusted(content, nonce = crypto.randomBytes(12).toString("hex")) {
  const open = `<<<REPOSITORY_DATA ${nonce}>>>`;
  const close = `<<<END_REPOSITORY_DATA ${nonce}>>>`;
  return {
    nonce,
    text: `${open}\n${content.split(close).join("[boundary removed]")}\n${close}`
  };
}

/**
 * @param {Review} review
 * @param {RenderMeta} meta
 */
export function renderReview(review, meta) {
  const lines = [
    `# Grok adversarial review: ${review.verdict === "approve" ? "APPROVE" : "NEEDS ATTENTION"}`,
    "",
    `- **Model:** ${meta.model}`,
    `- **Target:** ${meta.target}`,
    `- **Kernel sandbox:** ${meta.sandbox}`,
    `- **Integrity check:** ${meta.integrity}`,
    `- **Isolation:** ${meta.isolation}`
  ];
  if (meta.truncated) {
    lines.push("- **Note:** the diff was too large to inline; Grok was told to read the remaining files itself.");
  }
  if (meta.sessionId) {
    lines.push(`- **Grok session:** \`${meta.sessionId}\``);
  }
  lines.push("", review.summary.trim(), "");

  const findings = [...review.findings].sort(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || b.confidence - a.confidence
  );
  if (findings.length === 0) {
    lines.push("No material findings.", "");
  } else {
    lines.push(`## Findings (${findings.length})`, "");
    findings.forEach((finding, index) => {
      const range = finding.line_end > finding.line_start ? `${finding.line_start}-${finding.line_end}` : `${finding.line_start}`;
      lines.push(
        `### ${index + 1}. [${finding.severity.toUpperCase()}] ${finding.title}`,
        `\`${finding.file}:${range}\` · confidence ${finding.confidence.toFixed(2)}`,
        "",
        finding.body.trim(),
        "",
        `**Recommendation:** ${finding.recommendation.trim()}`,
        ""
      );
    });
  }
  if (review.next_steps.length > 0) {
    lines.push("## Next steps", "", ...review.next_steps.map((step) => `- ${step}`), "");
  }
  return lines.join("\n");
}

/**
 * @param {string[]} changedPaths
 * @param {string} sandboxDetail
 */
export function renderViolation(changedPaths, sandboxDetail) {
  return [
    "# GUARDRAIL VIOLATION: the repository changed during the Grok review",
    "",
    "The review was supposed to be read-only, but these entries differ from the snapshot taken before Grok started:",
    "",
    ...changedPaths.map((entry) => `- ${JSON.stringify(entry)}`),
    "",
    `Kernel sandbox for this run: ${sandboxDetail}.`,
    "",
    "Nothing was reverted. If you or another tool edited these files during the review, that explains it; otherwise treat this as Grok writing to your repo and inspect `git status` / `git diff` (and `.git/hooks`, `.git/config` for `@git:` entries) before running anything.",
    "The review output was discarded because it was produced by a run that broke the read-only guarantee."
  ].join("\n");
}
