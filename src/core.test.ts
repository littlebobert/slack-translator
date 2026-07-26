import { describe, expect, it, vi } from "vitest";
import {
  buildNotificationInput,
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
  notifyAllChannelIds: ["CLOUD"],
  imessageRecipient: "+15555550123",
  imsgCliPath: "/opt/homebrew/opt/imsg/bin/imsg",
  notificationTitle: "Slack translation",
  maxConcurrency: 2,
  dedupeTtlSeconds: 3600,
  presenceCacheSeconds: 30,
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
  isThreadReply: false,
  isChannelNotification: false,
};

describe("Slack message filtering", () => {
  it("detects Japanese scripts but not English", () => {
    expect(containsJapanese("カタカナ and 日本語")).toBe(true);
    expect(containsJapanese("meeting at ten")).toBe(false);
  });

  it("accepts a Japanese DM", () => {
    expect(toRelayMessage(message(), config.slackUserId)).toEqual(relay);
  });

  it("normalizes OpenClaw's prefixed DM conversation target", () => {
    expect(toRelayMessage(message({
      conversationId: "user:u123",
      senderId: "uowner",
      isGroup: false,
    }), config.slackUserId)).toMatchObject({
      channelId: "U123",
      senderId: "uowner",
      isDirect: true,
    });
  });

  it("normalizes OpenClaw's prefixed channel target", () => {
    expect(toRelayMessage(message({
      conversationId: "channel:cloud",
      content: "Deployment completed",
      isGroup: true,
    }), config.slackUserId, false, config.notifyAllChannelIds)).toMatchObject({
      channelId: "CLOUD",
      isChannelNotification: true,
    });
  });

  it("accepts and cleans a Japanese channel mention", () => {
    expect(toRelayMessage(message({
      conversationId: "C123",
      content: "<@UOWNER> 資料を確認してください",
      isGroup: true,
      wasMentioned: true,
    }), config.slackUserId)?.text).toBe("資料を確認してください");
  });

  it("accepts a subscribed channel thread reply", () => {
    expect(toRelayMessage(message({
      conversationId: "C123",
      content: "資料を更新しました",
      isGroup: true,
      messageId: "124.000",
      threadId: "123.000",
    }), config.slackUserId, true)).toMatchObject({
      isDirect: false,
      isThreadReply: true,
      text: "資料を更新しました",
    });
  });

  it("rejects an unsubscribed channel thread reply", () => {
    expect(toRelayMessage(message({
      conversationId: "C123",
      isGroup: true,
      messageId: "124.000",
      threadId: "123.000",
    }), config.slackUserId, false)).toBeUndefined();
  });

  it("accepts every post in an explicitly configured channel", () => {
    expect(toRelayMessage(message({
      conversationId: "CLOUD",
      content: "Deployment completed",
      isGroup: true,
    }), config.slackUserId, false, config.notifyAllChannelIds)).toMatchObject({
      text: "Deployment completed",
      isChannelNotification: true,
    });
  });

  it("does not treat a mention in an all-message channel as a generic channel post", () => {
    expect(toRelayMessage(message({
      conversationId: "CLOUD",
      content: "<@UOWNER> Deployment failed",
      isGroup: true,
      wasMentioned: true,
    }), config.slackUserId, false, config.notifyAllChannelIds)?.isChannelNotification).toBe(false);
  });

  it("accepts an English DM for pass-through forwarding", () => {
    expect(toRelayMessage(message({ content: "Please review this" }), config.slackUserId)?.text)
      .toBe("Please review this");
  });

  it("accepts a self-authored DM for testing", () => {
    expect(toRelayMessage(message({ senderId: "UOWNER" }), config.slackUserId)?.senderId)
      .toBe("UOWNER");
  });

  it.each([
    ["non-mentioned channel", { conversationId: "C123", isGroup: true }],
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
    expect(buildNotificationInput(config, relay, "Tomorrow's meeting is at 10.", "https://slack.test/message", "Aiko S.")).toEqual({
      title: "From Slack: DM from Aiko S.:",
      message: "Tomorrow's meeting is at 10.",
      url: "https://slack.test/message",
    });
  });

  it("labels subscribed thread replies", () => {
    const input = buildNotificationInput(
      config,
      { ...relay, isDirect: false, isThreadReply: true },
      "The document was updated.",
      "https://slack.test/thread-reply",
    );
    expect(input.title).toBe("From Slack: Thread reply from Aiko:");
  });

  it("labels posts from channels configured for every-message notifications", () => {
    const input = buildNotificationInput(
      config,
      { ...relay, isDirect: false, isChannelNotification: true },
      "Deployment completed.",
      "https://slack.test/channel-post",
    );
    expect(input.title).toBe("From Slack: Channel post from Aiko:");
  });

  it("builds a useful fallback when translation fails", () => {
    const push = buildNotificationInput(config, relay, undefined, undefined);
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
  it("forwards English text without calling the model", async () => {
    const translate = vi.fn().mockResolvedValue("unused");
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    await processRelayMessage(config, { ...relay, text: "Please review this" }, {
      translate,
      getPermalink: vi.fn().mockResolvedValue("https://slack.test/message"),
      getSenderName: vi.fn().mockResolvedValue("Aiko"),
      sendNotification,
      log: vi.fn(),
    });
    expect(translate).not.toHaveBeenCalled();
    expect(sendNotification.mock.calls[0]?.[0].message).toContain("Please review this");
  });

  it("sends a fallback message when model and permalink calls fail", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    await processRelayMessage(config, relay, {
      translate: vi.fn().mockRejectedValue(new Error("model unavailable")),
      getPermalink: vi.fn().mockRejectedValue(new Error("Slack unavailable")),
      getSenderName: vi.fn().mockResolvedValue("Aiko"),
      sendNotification,
      log: vi.fn(),
    });
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(sendNotification.mock.calls[0]?.[0].message).toContain("Translation failed");
  });
});
