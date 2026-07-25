import { describe, expect, it, vi } from "vitest";
import {
  buildPushInput,
  containsJapanese,
  processRelayMessage,
  toRelayMessage,
  truncateUtf8,
  TtlDeduplicator,
  withRetry,
} from "./core.js";
import type { InboundSlackMessage, RelayConfig, RelayMessage } from "./types.js";

const config: RelayConfig = {
  slackUserId: "UOWNER",
  slackUserTokenEnv: "SLACK_USER_TOKEN",
  pushoverUserKeyEnv: "PUSHOVER_USER_KEY",
  pushoverAppTokenEnv: "PUSHOVER_APP_TOKEN",
  notificationTitle: "Slack translation",
  maxConcurrency: 2,
  dedupeTtlSeconds: 3600,
  requestTimeoutMs: 10_000,
};

function message(overrides: Partial<InboundSlackMessage> = {}): InboundSlackMessage {
  return {
    channel: "slack",
    conversationId: "D123",
    content: "明日の会議は10時です",
    senderId: "UOTHER",
    senderName: "Aiko",
    messageId: "123.456",
    isGroup: false,
    ...overrides,
  };
}

const relay: RelayMessage = {
  channelId: "D123",
  messageTs: "123.456",
  senderId: "UOTHER",
  senderName: "Aiko",
  text: "明日の会議は10時です",
  isDirect: true,
};

describe("Slack message filtering", () => {
  it("detects Japanese scripts but not English", () => {
    expect(containsJapanese("カタカナ and 日本語")).toBe(true);
    expect(containsJapanese("meeting at ten")).toBe(false);
  });

  it("accepts a Japanese DM", () => {
    expect(toRelayMessage(message(), config.slackUserId)).toEqual(relay);
  });

  it("accepts and cleans a Japanese channel mention", () => {
    expect(toRelayMessage(message({
      conversationId: "C123",
      content: "<@UOWNER> 資料を確認してください",
      isGroup: true,
      wasMentioned: true,
    }), config.slackUserId)?.text).toBe("資料を確認してください");
  });

  it.each([
    ["non-mentioned channel", { conversationId: "C123", isGroup: true }],
    ["English message", { content: "Please review this" }],
    ["self-authored message", { senderId: "UOWNER" }],
    ["message edit", { metadata: { subtype: "message_changed" } }],
    ["other provider", { channel: "discord" }],
  ])("rejects %s", (_name, overrides) => {
    expect(toRelayMessage(message(overrides), config.slackUserId)).toBeUndefined();
  });
});

describe("deduplication", () => {
  it("rejects a retry until the TTL expires", () => {
    let now = 1_000;
    const dedupe = new TtlDeduplicator(100, 10, () => now);
    expect(dedupe.accept("D123:123.456")).toBe(true);
    expect(dedupe.accept("D123:123.456")).toBe(false);
    now += 101;
    expect(dedupe.accept("D123:123.456")).toBe(true);
  });
});

describe("notification construction", () => {
  it("preserves a permalink and resolved sender", () => {
    expect(buildPushInput(config, relay, "Tomorrow's meeting is at 10.", "https://slack.test/message", "Aiko S.")).toEqual({
      title: "Slack translation",
      message: "DM from Aiko S.\n\nTomorrow's meeting is at 10.",
      url: "https://slack.test/message",
      urlTitle: "Open in Slack",
    });
  });

  it("builds a useful fallback when translation fails", () => {
    const push = buildPushInput(config, relay, undefined, undefined);
    expect(push.message).toContain("Translation failed");
    expect(push.url).toBeUndefined();
  });

  it("truncates by UTF-8 bytes", () => {
    const result = truncateUtf8("日".repeat(500), 1024);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(1024);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("retry behavior", () => {
  it("retries transient model failures", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue("translated");
    await expect(withRetry(operation, 1, 0)).resolves.toBe("translated");
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

describe("relay processing", () => {
  it("sends a fallback push when model and permalink calls fail", async () => {
    const sendPush = vi.fn().mockResolvedValue(undefined);
    await processRelayMessage(config, relay, {
      translate: vi.fn().mockRejectedValue(new Error("model unavailable")),
      getPermalink: vi.fn().mockRejectedValue(new Error("Slack unavailable")),
      getSenderName: vi.fn().mockResolvedValue("Aiko"),
      sendPush,
      log: vi.fn(),
    });
    expect(sendPush).toHaveBeenCalledOnce();
    expect(sendPush.mock.calls[0]?.[0].message).toContain("Translation failed");
  });
});
