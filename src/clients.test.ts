import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import {
  getSlackPermalink,
  isSlackThreadSubscribed,
  sendIMessage,
  SlackPresenceCache,
  SlackUserCache,
} from "./clients.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Slack clients", () => {
  it("requests the exact message permalink with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      permalink: "https://workspace.slack.com/archives/D123/p123456",
    }), { status: 200 }));
    globalThis.fetch = fetchMock;

    const permalink = await getSlackPermalink("xoxp-secret", "D123", "123.456", 1000);

    expect(permalink).toContain("workspace.slack.com");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("chat.getPermalink?channel=D123&message_ts=123.456");
    expect(init.headers).toEqual({ Authorization: "Bearer xoxp-secret" });
  });

  it("checks the authenticated user's thread subscription", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      messages: [{ ts: "123.000", subscribed: true }],
    }), { status: 200 }));
    globalThis.fetch = fetchMock;

    await expect(isSlackThreadSubscribed("xoxp-secret", "C123", "123.000", 1000))
      .resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("conversations.replies?channel=C123&ts=123.000&limit=1");
    expect(init.headers).toEqual({ Authorization: "Bearer xoxp-secret" });
  });

  it("treats an absent subscription flag as unsubscribed", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      messages: [{ ts: "123.000" }],
    }), { status: 200 }));

    await expect(isSlackThreadSubscribed("xoxp-secret", "C123", "123.000", 1000))
      .resolves.toBe(false);
  });

  it("checks and caches the authenticated user's Slack presence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      presence: "away",
    }), { status: 200 }));
    globalThis.fetch = fetchMock;
    const presence = new SlackPresenceCache("xoxp-secret", "UOWNER", 1000, 30_000);

    expect(await presence.getPresence()).toBe("away");
    expect(await presence.getPresence()).toBe("away");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toContain("users.getPresence?user=UOWNER");
  });

  it("caches resolved Slack display names", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      user: { profile: { display_name: "Aiko" } },
    }), { status: 200 }));
    globalThis.fetch = fetchMock;
    const cache = new SlackUserCache("xoxp-secret", 1000);

    expect(await cache.getDisplayName("U123")).toBe("Aiko");
    expect(await cache.getDisplayName("U123")).toBe("Aiko");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("iMessage client", () => {
  it("sends the translation and Slack URL as one argument without a shell", async () => {
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => callback(null, "", ""));

    await sendIMessage("/opt/homebrew/bin/imsg", "+15555550123", {
      title: "Slack translation",
      message: "Translated text; $(touch /tmp/unsafe)",
      url: "https://workspace.slack.com/message",
      urlTitle: "Open in Slack",
    }, 1000);

    expect(execFileMock).toHaveBeenCalledOnce();
    const [file, args, options] = execFileMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(file).toBe("/opt/homebrew/bin/imsg");
    expect(args).toEqual([
      "send",
      "--to",
      "+15555550123",
      "--text",
      "Slack translation\nTranslated text; $(touch /tmp/unsafe)\nLink: https://workspace.slack.com/message",
    ]);
    expect(options).toMatchObject({ timeout: 1000 });
  });

  it("wraps imsg failures without exposing message text", async () => {
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => callback(new Error("denied")));
    await expect(sendIMessage("imsg", "+15555550123", {
      title: "Title",
      message: "Sensitive message",
    }, 1000)).rejects.toThrow("iMessage delivery failed");
  });
});
