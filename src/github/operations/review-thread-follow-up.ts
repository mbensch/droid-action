import { readFile } from "fs/promises";
import type { Octokits } from "../api/client";
import {
  fetchReviewThreads,
  type ReviewThread,
  type ReviewThreadComment,
} from "../data/review-threads";

export const DISPOSITION_MARKER_PREFIX = "<!-- droid-disposition:";

type ResolveDecision = {
  action: "resolve";
  threadId: string;
  commentId: string;
  bodyHash: string;
  evidence: string;
};
type ReplyDecision = {
  action: "reply";
  threadId: string;
  commentId: string;
  bodyHash: string;
  verdict: "agree" | "disagree";
  explanation: string;
};
type ThreadDecision = ResolveDecision | ReplyDecision;

export type ThreadFollowUpResult = {
  applied: number;
  skipped: number;
  failed: number;
  failures: string[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseThreadDecisions(raw: string): {
  headSha: string | null;
  decisions: ThreadDecision[];
  skipped: number;
} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { headSha: null, decisions: [], skipped: 1 };
  }
  const root = record(value);
  if (!root || !Array.isArray(root.decisions)) {
    return { headSha: null, decisions: [], skipped: 1 };
  }

  const decisions: ThreadDecision[] = [];
  let skipped = 0;
  for (const item of root.decisions) {
    const decision = record(item);
    const threadId = decision && nonEmpty(decision.threadId);
    const commentId = decision && nonEmpty(decision.commentId);
    const bodyHash = decision && nonEmpty(decision.bodyHash);
    if (!decision || !threadId || !commentId || !bodyHash) {
      skipped += 1;
      continue;
    }
    if (decision.action === "resolve") {
      const evidence = nonEmpty(decision.evidence);
      if (!evidence) {
        skipped += 1;
        continue;
      }
      decisions.push({
        action: "resolve",
        threadId,
        commentId,
        bodyHash,
        evidence,
      });
    } else if (
      decision.action === "reply" &&
      (decision.verdict === "agree" || decision.verdict === "disagree")
    ) {
      const explanation =
        typeof decision.explanation === "string"
          ? decision.explanation.trim()
          : "";
      if (decision.verdict === "disagree" && !explanation) {
        skipped += 1;
        continue;
      }
      decisions.push({
        action: "reply",
        threadId,
        commentId,
        bodyHash,
        verdict: decision.verdict,
        explanation,
      });
    } else {
      skipped += 1;
    }
  }
  return {
    headSha: nonEmpty(root.headSha),
    decisions,
    skipped,
  };
}

function loginSet(value: string | undefined, defaults: string[]): Set<string> {
  return new Set(
    (value ? value.split(",") : defaults)
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
}

function findTarget(
  threads: ReviewThread[],
  decision: ThreadDecision,
): { thread: ReviewThread; comment: ReviewThreadComment } | null {
  const thread = threads.find((item) => item.id === decision.threadId);
  const comment = thread?.comments.find(
    (item) =>
      item.id === decision.commentId && item.bodyHash === decision.bodyHash,
  );
  return thread && comment ? { thread, comment } : null;
}

function alreadyReplied(thread: ReviewThread, commentId: string): boolean {
  const marker = `${DISPOSITION_MARKER_PREFIX}${commentId} -->`;
  return thread.comments.some((comment) => comment.body.includes(marker));
}

export async function applyReviewThreadFollowUp(options: {
  client: Octokits;
  owner: string;
  repo: string;
  prNumber: number;
  decisionsPath: string;
  resolveFixedThreads: boolean;
  reviewOtherBotComments: boolean;
  droidLogins?: string;
  otherBotLogins?: string;
}): Promise<ThreadFollowUpResult> {
  const result: ThreadFollowUpResult = {
    applied: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };
  let raw: string;
  try {
    raw = await readFile(options.decisionsPath, "utf8");
  } catch {
    return result;
  }

  const parsed = parseThreadDecisions(raw);
  result.skipped += parsed.skipped;
  const snapshot = await fetchReviewThreads(
    options.client,
    options.owner,
    options.repo,
    options.prNumber,
  );
  if (
    !parsed.headSha ||
    parsed.headSha.toLowerCase() !== snapshot.headSha.toLowerCase()
  ) {
    result.skipped += parsed.decisions.length;
    return result;
  }

  const droidLogins = loginSet(options.droidLogins, ["factory-droid[bot]"]);
  const otherBotLogins = loginSet(options.otherBotLogins, [
    "claude[bot]",
    "claude-code[bot]",
    "cursor[bot]",
    "cursorreview[bot]",
  ]);
  const seen = new Set<string>();

  for (const decision of parsed.decisions) {
    const key = `${decision.action}:${decision.commentId}`;
    if (seen.has(key)) {
      result.skipped += 1;
      continue;
    }
    seen.add(key);
    const target = findTarget(snapshot.threads, decision);
    if (!target || target.thread.isResolved) {
      result.skipped += 1;
      continue;
    }

    try {
      if (decision.action === "resolve") {
        const root = target.thread.comments[0];
        if (
          !options.resolveFixedThreads ||
          !root ||
          root.id !== target.comment.id ||
          !root.authorLogin ||
          !droidLogins.has(root.authorLogin.toLowerCase())
        ) {
          result.skipped += 1;
          continue;
        }
        await options.client.graphql(
          `mutation ResolveReviewThread($threadId: ID!) {
            resolveReviewThread(input: {threadId: $threadId}) {
              thread { id isResolved }
            }
          }`,
          { threadId: target.thread.id },
        );
      } else {
        if (
          !options.reviewOtherBotComments ||
          !target.comment.authorLogin ||
          !otherBotLogins.has(target.comment.authorLogin.toLowerCase()) ||
          alreadyReplied(target.thread, target.comment.id)
        ) {
          result.skipped += 1;
          continue;
        }
        const visibleBody =
          decision.verdict === "agree"
            ? "Droid agrees."
            : `Droid disagrees: ${decision.explanation}`;
        await options.client.rest.request(
          "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies",
          {
            owner: options.owner,
            repo: options.repo,
            pull_number: options.prNumber,
            comment_id: target.comment.databaseId,
            body: `${visibleBody}\n\n${DISPOSITION_MARKER_PREFIX}${target.comment.id} -->`,
          },
        );
      }
      result.applied += 1;
    } catch (error) {
      result.failed += 1;
      result.failures.push(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return result;
}
