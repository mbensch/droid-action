import { describe, expect, it } from "bun:test";
import {
  configuredBotLogins,
  isConfiguredBot,
  normalizeBotLogin,
} from "../../src/github/review-bot-identities";

describe("review bot identities", () => {
  it("normalizes only a trailing REST bot suffix", () => {
    expect(normalizeBotLogin(" Factory-Droid[bot] ")).toBe("factory-droid");
    expect(normalizeBotLogin("factory[bot]-copy")).toBe("factory[bot]-copy");
  });

  it("matches GraphQL Bot logins against REST-style configuration", () => {
    const configuredLogins = new Set(
      configuredBotLogins(" factory-droid[bot], CLAUDE[bot] ", []),
    );

    expect(
      isConfiguredBot({
        login: "factory-droid",
        actorType: "Bot",
        configuredLogins,
      }),
    ).toBe(true);
    expect(
      isConfiguredBot({
        login: "claude",
        actorType: "Bot",
        configuredLogins,
      }),
    ).toBe(true);
  });

  it("rejects humans, null authors, and unknown bots", () => {
    const configuredLogins = new Set(["factory-droid"]);

    expect(
      isConfiguredBot({
        login: "factory-droid",
        actorType: "User",
        configuredLogins,
      }),
    ).toBe(false);
    expect(
      isConfiguredBot({
        login: null,
        actorType: "Bot",
        configuredLogins,
      }),
    ).toBe(false);
    expect(
      isConfiguredBot({
        login: "other",
        actorType: "Bot",
        configuredLogins,
      }),
    ).toBe(false);
  });
});
