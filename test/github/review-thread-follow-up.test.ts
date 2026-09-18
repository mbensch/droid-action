import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import {
  applyReviewThreadFollowUp,
  parseThreadDecisions,
} from "../../src/github/operations/review-thread-follow-up";

const hash = (body: string) => createHash("sha256").update(body).digest("hex");

function threadPage(author = "claude[bot]", replies: any[] = []) {
  return {
    repository: {
      pullRequest: {
        headRefOid: "abcdef1234567",
        reviewThreads: {
          nodes: [
            {
              id: "T1",
              isResolved: false,
              isOutdated: false,
              path: "src/a.ts",
              line: 4,
              originalLine: 4,
              comments: {
                nodes: [
                  {
                    id: "C1",
                    databaseId: 101,
                    body: "This can crash.",
                    author: { login: author },
                    createdAt: "2026-09-17T00:00:00Z",
                    replyTo: null,
                    commit: { oid: "abcdef1234567" },
                    originalCommit: null,
                  },
                  ...replies,
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
}

describe("review-thread follow-up", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("parses only complete, supported decisions", () => {
    const parsed = parseThreadDecisions(
      JSON.stringify({
        headSha: "abc1234",
        decisions: [
          {
            action: "reply",
            threadId: "T1",
            commentId: "C1",
            bodyHash: "hash",
            verdict: "disagree",
            explanation: "",
          },
          {
            action: "resolve",
            threadId: "T2",
            commentId: "C2",
            bodyHash: "hash",
            evidence: "Guard added at line 8.",
          },
        ],
      }),
    );
    expect(parsed.decisions).toHaveLength(1);
    expect(parsed.skipped).toBe(1);
  });

  it("posts one exact visible disposition with a dedupe marker", async () => {
    directory = await mkdtemp(join(tmpdir(), "thread-follow-up-"));
    const decisionsPath = join(directory, "decisions.json");
    await writeFile(
      decisionsPath,
      JSON.stringify({
        headSha: "abcdef1234567",
        decisions: [
          {
            action: "reply",
            threadId: "T1",
            commentId: "C1",
            bodyHash: hash("This can crash."),
            verdict: "agree",
            explanation: "",
          },
        ],
      }),
    );
    const request = mock(async (_route: string, _params: any) => ({
      data: {},
    }));
    const client = {
      graphql: mock(async () => threadPage()),
      rest: { request },
    } as any;

    const result = await applyReviewThreadFollowUp({
      client,
      owner: "owner",
      repo: "repo",
      prNumber: 42,
      decisionsPath,
      resolveFixedThreads: false,
      reviewOtherBotComments: true,
    });

    expect(result.applied).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1].body).toStartWith("Droid agrees.");
    expect(request.mock.calls[0]![1].body).toContain(
      "<!-- droid-disposition:C1 -->",
    );
  });

  it("skips stale heads and duplicate dispositions", async () => {
    directory = await mkdtemp(join(tmpdir(), "thread-follow-up-"));
    const decisionsPath = join(directory, "decisions.json");
    const decision = {
      action: "reply",
      threadId: "T1",
      commentId: "C1",
      bodyHash: hash("This can crash."),
      verdict: "agree",
      explanation: "",
    };
    const request = mock(async (_route: string, _params: any) => ({
      data: {},
    }));
    const client = {
      graphql: mock(async () =>
        threadPage("claude[bot]", [
          {
            id: "D1",
            databaseId: 102,
            body: "Droid agrees.\n\n<!-- droid-disposition:C1 -->",
            author: { login: "factory-droid[bot]" },
            createdAt: "2026-09-17T01:00:00Z",
            replyTo: { id: "C1" },
            commit: { oid: "abcdef1234567" },
            originalCommit: null,
          },
        ]),
      ),
      rest: { request },
    } as any;

    await writeFile(
      decisionsPath,
      JSON.stringify({ headSha: "different123", decisions: [decision] }),
    );
    const stale = await applyReviewThreadFollowUp({
      client,
      owner: "owner",
      repo: "repo",
      prNumber: 42,
      decisionsPath,
      resolveFixedThreads: false,
      reviewOtherBotComments: true,
    });
    expect(stale.skipped).toBe(1);

    await writeFile(
      decisionsPath,
      JSON.stringify({ headSha: "abcdef1234567", decisions: [decision] }),
    );
    const duplicate = await applyReviewThreadFollowUp({
      client,
      owner: "owner",
      repo: "repo",
      prNumber: 42,
      decisionsPath,
      resolveFixedThreads: false,
      reviewOtherBotComments: true,
    });
    expect(duplicate.skipped).toBe(1);
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves only trusted Droid root threads", async () => {
    directory = await mkdtemp(join(tmpdir(), "thread-follow-up-"));
    const decisionsPath = join(directory, "decisions.json");
    await writeFile(
      decisionsPath,
      JSON.stringify({
        headSha: "abcdef1234567",
        decisions: [
          {
            action: "resolve",
            threadId: "T1",
            commentId: "C1",
            bodyHash: hash("This can crash."),
            evidence: "The current code checks for null before dereference.",
          },
        ],
      }),
    );
    const graphql = mock(async (query: string) =>
      query.includes("mutation")
        ? { resolveReviewThread: {} }
        : threadPage("factory-droid[bot]"),
    );
    const result = await applyReviewThreadFollowUp({
      client: { graphql, rest: { request: mock() } } as any,
      owner: "owner",
      repo: "repo",
      prNumber: 42,
      decisionsPath,
      resolveFixedThreads: true,
      reviewOtherBotComments: false,
    });
    expect(result.applied).toBe(1);
    expect(graphql).toHaveBeenCalledTimes(2);
  });
});
