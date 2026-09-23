// @ts-check
import crypto from "node:crypto";

// Mirrors fingerprint.mjs IGNORED_TRUNCATED_KEY without importing git plumbing into rendering.
const IGNORED_TRUNCATED_KEY_NAME = "@ignored:truncated";

const SEVERITIES = ["critical", "high", "medium", "low"];

/**
 * @typedef {{ severity: "critical" | "high" | "medium" | "low", title: string, body: string, file: string, line_start: number, line_end: number, confidence: number, recommendation: string }} Finding
 * @typedef {{ verdict: "approve" | "needs-attention", summary: string, findings: Finding[], next_steps: string[] }} Review
 * @typedef {{ model: string, target: string, sandbox: string, integrity: string, isolation: string, truncated: boolean, sessionId: string | null, changedDuringReview: string[] }} RenderMeta
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
    `- **Changes during review:** ${meta.integrity}`,
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
  if (meta.changedDuringReview.length > 0) {
    lines.push(renderChangesDuringReview(meta.changedDuringReview));
  }
  return lines.join("\n");
}

/**
 * Turns a fingerprint key into something a person recognizes.
 * @param {string} key
 * @returns {string}
 */
export function describeChange(key) {
  if (key === "@HEAD") {
    return "HEAD (a commit, checkout, or reset happened)";
  }
  if (key === "@refs") {
    return "branches, tags, or stash";
  }
  if (key === "@index" || key === "@index-flags") {
    return "the git staging area (index)";
  }
  if (key === IGNORED_TRUNCATED_KEY_NAME) {
    return "the set of ignored files";
  }
  if (key.startsWith("@sub:")) {
    // "@sub:<submodule path>/<inner key>": inner keys starting with @ mark where the path ends.
    const rest = key.slice("@sub:".length);
    const split = rest.indexOf("/@");
    return split === -1 ? `${rest} (in a submodule)` : `${describeChange(rest.slice(split + 1))} (in submodule ${rest.slice(0, split)})`;
  }
  for (const [prefix, render] of /** @type {[string, (rest: string) => string][]} */ ([
    ["@git:", (rest) => `.git/${rest}`],
    ["@ignored:", (rest) => `${rest} (ignored file)`],
    ["@flagged:", (rest) => rest],
    ["@grok-home:", (rest) => `~/.grok/${rest}`]
  ])) {
    if (key.startsWith(prefix)) {
      return render(key.slice(prefix.length));
    }
  }
  return key;
}

/**
 * The files that changed while Grok was reviewing: usually edits by the user or another tool.
 * @param {string[]} changedKeys
 * @param {{ afterFailure?: boolean }} [options] afterFailure: the review failed for another reason
 */
export function renderChangesDuringReview(changedKeys, options = {}) {
  const descriptions = [...new Set(changedKeys.map(describeChange))];
  return [
    options.afterFailure
      ? `## For information only, NOT the cause of the failure above: files changed while Grok was running (${descriptions.length})`
      : `## Changed while the review was running (${descriptions.length})`,
    "",
    options.afterFailure
      ? "These are listed so you know about them. They did not make the review fail."
      : "These changed after Grok started reviewing, so the review may describe them as they were before. Grok's tools are read-only, so this is normally your own editing or another tool's.",
    "",
    ...descriptions.map((entry) => `- ${JSON.stringify(entry)}`),
    ""
  ].join("\n");
}
