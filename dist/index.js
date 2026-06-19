// DotNetCodeReviewer GitHub Action
// Reviews the C# files changed in a pull request and posts the findings as an
// inline PR review. Uses only Node built-ins + the GitHub REST API (no npm install).
// Flow:
//   1. Read inputs and the PR event payload.
//   2. List the files changed in the PR (GitHub API).
//   3. For each changed .cs file, read its content and POST it to the
//      DotNetCodeReviewer API (/api/v1/review/file).
//   4. Map findings to inline review comments (only on lines the PR touched).
//   5. Submit one PR review with a summary + inline comments.
//   6. Optionally fail the check based on the `fail-on` severity threshold.

const fs = require("fs");

const SEVERITY_RANK = { info: 0, suggestion: 1, warning: 2, critical: 3 };
const SEVERITY_EMOJI = { Critical: "🛑", Warning: "⚠️", Suggestion: "💡", Info: "ℹ️" };

function getInput(name, fallback = "") {
  const v = process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`];
  return v === undefined || v === "" ? fallback : v;
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${name}=${value}\n`);
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function gh(token, method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "dotnetcodereviewer-action",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${method} ${url} failed: ${res.status} ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function reviewFile(apiUrl, apiKey, fileName, content) {
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}/api/v1/review/file`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify({ content, fileName }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`API rejected the key (HTTP ${res.status}). Check your DNCR_API_KEY secret and that your plan covers this.`);
  }
  if (res.status === 429) {
    console.log(`::warning::Rate limit / quota reached while reviewing ${fileName}; skipping the rest.`);
    return { quotaExhausted: true, issues: [] };
  }
  if (!res.ok) {
    const text = await res.text();
    console.log(`::warning::Review failed for ${fileName}: ${res.status} ${text}`);
    return { issues: [] };
  }
  return res.json();
}

function summary(allFindings, reviewedCount, skipped) {
  const counts = { Critical: 0, Warning: 0, Suggestion: 0, Info: 0 };
  for (const f of allFindings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const total = allFindings.length;

  let body = "## 🔍 DotNetCodeReviewer\n\n";
  if (total === 0) {
    body += `Reviewed **${reviewedCount}** changed C# file(s) — no issues found. ✅`;
  } else {
    body += `Reviewed **${reviewedCount}** changed C# file(s) and found **${total}** issue(s):\n\n`;
    body += `${SEVERITY_EMOJI.Critical} Critical: **${counts.Critical}**  •  `;
    body += `${SEVERITY_EMOJI.Warning} Warning: **${counts.Warning}**  •  `;
    body += `${SEVERITY_EMOJI.Suggestion} Suggestion: **${counts.Suggestion}**  •  `;
    body += `${SEVERITY_EMOJI.Info} Info: **${counts.Info}**`;
  }
  if (skipped) body += `\n\n> Note: review stopped early because the API quota was reached.`;
  body += `\n\n<sub>Powered by DotNetCodeReviewer — Roslyn-based static analysis.</sub>`;
  return body;
}

function commentFor(finding) {
  const emoji = SEVERITY_EMOJI[finding.severity] || "";
  let b = `${emoji} **${finding.severity}: ${finding.title}** \`${finding.ruleId}\`\n\n${finding.description}`;
  if (finding.suggestion) b += `\n\n**Suggested fix:** ${finding.suggestion}`;
  return b;
}

async function main() {
  const apiKey = getInput("api-key");
  const apiUrl = getInput("api-url", "https://dotnetcodereviewer-api.azurewebsites.net");
  const token = getInput("github-token");
  const failOn = getInput("fail-on", "critical").toLowerCase();
  const maxFiles = parseInt(getInput("max-files", "50"), 10);

  if (!apiKey) fail("api-key input is required. Pass your DotNetCodeReviewer API key (e.g. from a repository secret).");

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) fail("No event payload found. This action must run on a pull_request event.");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const pr = event.pull_request;
  if (!pr) fail("This action only runs on pull_request events. Add `on: pull_request` to your workflow.");

  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  const prNumber = pr.number;
  const headSha = pr.head.sha;

  // 1. List changed files (paginated).
  let changed = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gh(token, "GET", `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    changed = changed.concat(batch);
    if (batch.length < 100) break;
  }

  // Only C# files that still exist (not deleted), and that have a patch (text diff).
  const csFiles = changed
    .filter((f) => f.filename.endsWith(".cs") && f.status !== "removed" && f.patch)
    .slice(0, maxFiles);

  if (csFiles.length === 0) {
    console.log("No changed C# files to review.");
    setOutput("total-issues", "0");
    setOutput("critical-issues", "0");
    return;
  }

  // Build the set of lines actually added/changed in the PR per file, so we only
  // comment on lines the author touched (GitHub rejects comments on other lines).
  const changedLines = {};
  for (const f of csFiles) {
    changedLines[f.filename] = parsePatchAddedLines(f.patch);
  }

  // 2. Review each file.
  const inlineComments = [];
  const allFindings = [];
  let skipped = false;

  for (const f of csFiles) {
    let content;
    try {
      content = fs.readFileSync(f.filename, "utf8");
    } catch {
      console.log(`::warning::Could not read ${f.filename} from the checkout; skipping.`);
      continue;
    }

    const result = await reviewFile(apiUrl, apiKey, f.filename, content);
    if (result.quotaExhausted) { skipped = true; break; }

    for (const issue of result.issues || []) {
      allFindings.push(issue);
      // Only attach as an inline comment if the issue is on a changed line.
      if (changedLines[f.filename] && changedLines[f.filename].has(issue.line)) {
        inlineComments.push({ path: f.filename, line: issue.line, body: commentFor(issue) });
      }
    }
  }

  // 3. Submit one review with summary + inline comments.
  const reviewBody = summary(allFindings, csFiles.length, skipped);
  try {
    await gh(token, "POST", `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
      commit_id: headSha,
      event: "COMMENT",
      body: reviewBody,
      comments: inlineComments,
    });
  } catch (e) {
    // If inline comments fail (e.g. line mapping), fall back to a plain summary comment.
    console.log(`::warning::Inline review failed (${e.message}); posting a summary comment instead.`);
    await gh(token, "POST", `/repos/${owner}/${repo}/issues/${prNumber}/comments`, { body: reviewBody });
  }

  // 4. Outputs + optional fail.
  const criticalCount = allFindings.filter((f) => f.severity === "Critical").length;
  setOutput("total-issues", String(allFindings.length));
  setOutput("critical-issues", String(criticalCount));

  if (failOn !== "none") {
    const threshold = SEVERITY_RANK[failOn] ?? SEVERITY_RANK.critical;
    const offending = allFindings.filter((f) => (SEVERITY_RANK[(f.severity || "").toLowerCase()] ?? 0) >= threshold);
    if (offending.length > 0) {
      fail(`Found ${offending.length} issue(s) at or above '${failOn}' severity. See the PR review for details.`);
    }
  }

  console.log(`Done. ${allFindings.length} issue(s), ${criticalCount} critical.`);
}

// Parse a unified diff patch and return the set of NEW-file line numbers that were added.
function parsePatchAddedLines(patch) {
  const added = new Set();
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { newLine = parseInt(hunk[1], 10); continue; }
    if (line.startsWith("+") && !line.startsWith("+++")) { added.add(newLine); newLine++; }
    else if (line.startsWith("-") && !line.startsWith("---")) { /* removed: no new-line advance */ }
    else { newLine++; }
  }
  return added;
}

main().catch((e) => fail(e.message));