import { describe, expect, it, mock } from "bun:test";
import { fetchReviewThreads } from "../../../src/github/data/review-threads";

const comment = (id: string, databaseId: number) => ({
  id,
  databaseId,
  body: `body ${id}`,
  author: { login: "factory-droid[bot]" },
  createdAt: "2026-09-17T00:00:00Z",
  replyTo: null,
  commit: { oid: "abc1234" },
  originalCommit: null,
});

describe("fetchReviewThreads", () => {
  it("paginates threads and nested comments and omits resolved threads", async () => {
    const graphql = mock(async (query: string, variables: any) => {
      if (query.includes("ReviewThreadComments")) {
        return {
          node: {
            comments: {
              nodes: [comment("C2", 2)],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }
      const secondPage = variables.after === "threads-2";
      return {
        repository: {
          pullRequest: {
            headRefOid: "abcdef1234567",
            reviewThreads: {
              nodes: secondPage
                ? [
                    {
                      id: "T2",
                      isResolved: true,
                      isOutdated: false,
                      path: "b.ts",
                      line: 2,
                      originalLine: 2,
                      comments: {
                        nodes: [comment("C3", 3)],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  ]
                : [
                    {
                      id: "T1",
                      isResolved: false,
                      isOutdated: true,
                      path: "a.ts",
                      line: null,
                      originalLine: 10,
                      comments: {
                        nodes: [comment("C1", 1)],
                        pageInfo: {
                          hasNextPage: true,
                          endCursor: "comments-2",
                        },
                      },
                    },
                  ],
              pageInfo: secondPage
                ? { hasNextPage: false, endCursor: null }
                : { hasNextPage: true, endCursor: "threads-2" },
            },
          },
        },
      };
    });

    const snapshot = await fetchReviewThreads(
      { graphql } as any,
      "owner",
      "repo",
      42,
    );

    expect(snapshot.headSha).toBe("abcdef1234567");
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]!.comments.map((item) => item.id)).toEqual([
      "C1",
      "C2",
    ]);
    expect(snapshot.threads[0]!.comments[0]!.bodyHash).toHaveLength(64);
    expect(graphql).toHaveBeenCalledTimes(3);
  });
});
