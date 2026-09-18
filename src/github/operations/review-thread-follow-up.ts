import { readFile } from "fs/promises";
import type { Octokits } from "../api/client";
import {
  fetchReviewThreads,
  type ReviewThread,
  type ReviewThreadComment,
} from "../data/review-threads";
import {
  configuredBotLogins,
  DEFAULT_DROID_REVIEW_BOT_LOGINS,
  DEFAULT_OTHER_REVIEW_BOT_LOGINS,
  isConfiguredBot,
} from "../review-bot-identities";

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
  skips: ThreadFollowUpSkip[];
};

export type ThreadFollowUpSkip = {
  action: "artifact" | "resolve" | "reply";
  targetId: string | null;
  reason: string;
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
  skipReasons: string[];
} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      headSha: null,
      decisions: [],
      skipped: 1,
      skipReasons: ["decision artifact is not valid JSON"],
    };
  }
  const root = record(value);
  if (!root || !Array.isArray(root.decisions)) {
    return {
      headSha: null,
      decisions: [],
      skipped: 1,
      skipReasons: ["decision artifact is missing a decisions array"],
    };
  }

  const decisions: ThreadDecision[] = [];
  let skipped = 0;
  const skipReasons: string[] = [];
  for (const item of root.decisions) {
    const decision = record(item);
    const threadId = decision && nonEmpty(decision.threadId);
    const commentId = decision && nonEmpty(decision.commentId);
    const bodyHash = decision && nonEmpty(decision.bodyHash);
    if (!decision || !threadId || !commentId || !bodyHash) {
      skipped += 1;
      skipReasons.push("decision is missing a target ID or body hash");
      continue;
    }
    if (decision.action === "resolve") {
      const evidence = nonEmpty(decision.evidence);
      if (!evidence) {
        skipped += 1;
        skipReasons.push(`resolve decision ${commentId} has no evidence`);
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
        skipReasons.push(`disagree decision ${commentId} has no explanation`);
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
      skipReasons.push(`decision ${commentId} has an unsupported action`);
    }
  }
  return {
    headSha: nonEmpty(root.headSha),
    decisions,
    skipped,
    skipReasons,
  };
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

function alreadyReplied(
  thread: ReviewThread,
  commentId: string,
  droidLogins: ReadonlySet<string>,
): boolean {
  const marker = `${DISPOSITION_MARKER_PREFIX}${commentId} -->`;
  return thread.comments.some(
    (comment) =>
      comment.body.includes(marker) &&
      isConfiguredBot({
        login: comment.authorLogin,
        actorType: comment.authorType,
        configuredLogins: droidLogins,
      }),
  );
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
    skips: [],
  };
  const skip = (
    action: ThreadFollowUpSkip["action"],
    targetId: string | null,
    reason: string,
  ): void => {
    result.skipped += 1;
    result.skips.push({ action, targetId, reason });
  };
  let raw: string;
  try {
    raw = await readFile(options.decisionsPath, "utf8");
  } catch (error) {
    skip(
      "artifact",
      null,
      error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
        ? "decision artifact is missing"
        : `decision artifact could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return result;
  }

  const parsed = parseThreadDecisions(raw);
  for (const reason of parsed.skipReasons) skip("artifact", null, reason);
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
    for (const decision of parsed.decisions) {
      skip(decision.action, decision.commentId, "review head changed");
    }
    return result;
  }

  const droidLogins = new Set(
    configuredBotLogins(options.droidLogins, DEFAULT_DROID_REVIEW_BOT_LOGINS),
  );
  const otherBotLogins = new Set(
    configuredBotLogins(
      options.otherBotLogins,
      DEFAULT_OTHER_REVIEW_BOT_LOGINS,
    ),
  );
  const seen = new Set<string>();

  for (const decision of parsed.decisions) {
    const key = `${decision.action}:${decision.commentId}`;
    if (seen.has(key)) {
      skip(decision.action, decision.commentId, "duplicate decision");
      continue;
    }
    seen.add(key);
    const target = findTarget(snapshot.threads, decision);
    if (!target) {
      skip(decision.action, decision.commentId, "target is missing or changed");
      continue;
    }
    if (target.thread.isResolved) {
      skip(decision.action, decision.commentId, "thread is already resolved");
      continue;
    }

    try {
      if (decision.action === "resolve") {
        const root = target.thread.comments[0];
        if (!options.resolveFixedThreads) {
          skip("resolve", decision.commentId, "resolution is disabled");
          continue;
        }
        if (!root || root.id !== target.comment.id) {
          skip("resolve", decision.commentId, "target is not the thread root");
          continue;
        }
        if (
          !isConfiguredBot({
            login: root.authorLogin,
            actorType: root.authorType,
            configuredLogins: droidLogins,
          })
        ) {
          skip(
            "resolve",
            decision.commentId,
            "root author is not a configured Droid bot",
          );
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
        if (!options.reviewOtherBotComments) {
          skip("reply", decision.commentId, "bot-comment review is disabled");
          continue;
        }
        if (
          !isConfiguredBot({
            login: target.comment.authorLogin,
            actorType: target.comment.authorType,
            configuredLogins: otherBotLogins,
          })
        ) {
          skip(
            "reply",
            decision.commentId,
            "target author is not a configured review bot",
          );
          continue;
        }
        if (alreadyReplied(target.thread, target.comment.id, droidLogins)) {
          skip("reply", decision.commentId, "Droid already replied");
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
