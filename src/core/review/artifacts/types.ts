/**
 * Shared shape for the three on-disk review artifacts. Both GitHub and
 * GitLab pipelines pre-compute the same trio (diff, existing comments,
 * description) and write them under `${tempDir}/droid-prompts/`, then
 * pass the resulting paths into the Pass 1 / Pass 2 prompts.
 *
 * The fetch mechanics differ substantially per platform (git+gh CLI vs
 * REST API), so we don't try to share the fetchers — only the path
 * shape and the disk-write helper.
 */
export type ReviewArtifactPaths = {
  diffPath: string;
  commentsPath: string;
  descriptionPath: string;
  /** GitHub-only snapshot used by the optional review-thread follow-up. */
  threadsPath?: string;
};

/**
 * Raw content for each of the three artifacts, before they're written
 * to disk by `writeReviewArtifacts`.
 */
export type ReviewArtifactContents = {
  diff: string;
  comments: unknown; // JSON-serializable
  description: string;
};

/**
 * Naming convention for review-artifact files on disk. Each platform
 * gets its own basename for the diff and description (pr.diff /
 * mr.diff, pr_description.txt / mr_description.txt) but the existing
 * comments file is platform-neutral.
 */
export type ReviewArtifactNames = {
  diff: string;
  comments: string;
  description: string;
};
