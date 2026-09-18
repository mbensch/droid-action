import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import type { Octokits } from "../api/client";

export type ReviewThreadComment = {
  id: string;
  databaseId: number;
  body: string;
  bodyHash: string;
  authorLogin: string | null;
  createdAt: string;
  replyToId: string | null;
  commitOid: string | null;
};

export type ReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  comments: ReviewThreadComment[];
};

export type ReviewThreadsSnapshot = {
  version: 1;
  headSha: string;
  capturedAt: string;
  threads: ReviewThread[];
};

type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type RawComment = {
  id: string;
  databaseId: number;
  body: string;
  author: { login: string } | null;
  createdAt: string;
  replyTo: { id: string } | null;
  commit: { oid: string } | null;
  originalCommit: { oid: string } | null;
};
type RawThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  comments: { nodes: RawComment[]; pageInfo: PageInfo };
};

const THREADS_QUERY = `
  query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        headRefOid
        reviewThreads(first: 50, after: $after) {
          nodes {
            id isResolved isOutdated path line originalLine
            comments(first: 100) {
              nodes {
                id databaseId body createdAt
                author { login }
                replyTo { id }
                commit { oid }
                originalCommit { oid }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const COMMENTS_QUERY = `
  query ReviewThreadComments($threadId: ID!, $after: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $after) {
          nodes {
            id databaseId body createdAt
            author { login }
            replyTo { id }
            commit { oid }
            originalCommit { oid }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

function normalizeComment(comment: RawComment): ReviewThreadComment {
  return {
    id: comment.id,
    databaseId: comment.databaseId,
    body: comment.body,
    bodyHash: createHash("sha256").update(comment.body).digest("hex"),
    authorLogin: comment.author?.login ?? null,
    createdAt: comment.createdAt,
    replyToId: comment.replyTo?.id ?? null,
    commitOid: comment.commit?.oid ?? comment.originalCommit?.oid ?? null,
  };
}

export async function fetchReviewThreads(
  octokit: Octokits,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewThreadsSnapshot> {
  const threads: RawThread[] = [];
  let after: string | null = null;
  let headSha = "";

  do {
    const page: {
      repository: {
        pullRequest: {
          headRefOid: string;
          reviewThreads: { nodes: RawThread[]; pageInfo: PageInfo };
        } | null;
      } | null;
    } = await octokit.graphql(THREADS_QUERY, {
      owner,
      repo,
      number: prNumber,
      after,
    });
    const pullRequest = page.repository?.pullRequest;
    if (!pullRequest)
      throw new Error(`Pull request #${prNumber} was not found`);
    headSha = pullRequest.headRefOid;
    threads.push(...pullRequest.reviewThreads.nodes);
    after = pullRequest.reviewThreads.pageInfo.hasNextPage
      ? pullRequest.reviewThreads.pageInfo.endCursor
      : null;
  } while (after);

  for (const thread of threads) {
    let commentsAfter = thread.comments.pageInfo.hasNextPage
      ? thread.comments.pageInfo.endCursor
      : null;
    while (commentsAfter) {
      const page: {
        node: {
          comments: { nodes: RawComment[]; pageInfo: PageInfo };
        } | null;
      } = await octokit.graphql(COMMENTS_QUERY, {
        threadId: thread.id,
        after: commentsAfter,
      });
      if (!page.node) break;
      thread.comments.nodes.push(...page.node.comments.nodes);
      commentsAfter = page.node.comments.pageInfo.hasNextPage
        ? page.node.comments.pageInfo.endCursor
        : null;
    }
  }

  return {
    version: 1,
    headSha,
    capturedAt: new Date().toISOString(),
    threads: threads
      .filter((thread) => !thread.isResolved)
      .map((thread) => ({
        id: thread.id,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        path: thread.path,
        line: thread.line,
        originalLine: thread.originalLine,
        comments: thread.comments.nodes.map(normalizeComment),
      })),
  };
}

export async function fetchAndStoreReviewThreads(
  octokit: Octokits,
  owner: string,
  repo: string,
  prNumber: number,
  tempDir: string,
): Promise<string> {
  const promptsDir = `${tempDir}/droid-prompts`;
  await mkdir(promptsDir, { recursive: true });
  const snapshot = await fetchReviewThreads(octokit, owner, repo, prNumber);
  const threadsPath = `${promptsDir}/review_threads.json`;
  await writeFile(threadsPath, JSON.stringify(snapshot, null, 2));
  console.log(
    `Stored ${snapshot.threads.length} unresolved review threads at ${threadsPath}`,
  );
  return threadsPath;
}
