export const DEFAULT_DROID_REVIEW_BOT_LOGINS = ["factory-droid[bot]"];

export const DEFAULT_OTHER_REVIEW_BOT_LOGINS = [
  "claude[bot]",
  "claude-code[bot]",
  "cursor[bot]",
  "cursorreview[bot]",
];

/**
 * GitHub's REST API commonly returns app logins with a `[bot]` suffix while
 * GraphQL's Bot actor returns the same login without it. Normalize only that
 * exact suffix; substring matching would allow unrelated accounts.
 */
export function normalizeBotLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, "");
}

export function configuredBotLogins(
  value: string | undefined,
  defaults: string[],
): string[] {
  return [
    ...new Set((value ? value.split(",") : defaults).map(normalizeBotLogin)),
  ].filter(Boolean);
}

export function isConfiguredBot(options: {
  login: string | null;
  actorType: string | null;
  configuredLogins: ReadonlySet<string>;
}): boolean {
  return (
    options.actorType === "Bot" &&
    options.login !== null &&
    options.configuredLogins.has(normalizeBotLogin(options.login))
  );
}
