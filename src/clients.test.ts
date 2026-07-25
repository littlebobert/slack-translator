import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSlackPermalink,
  sendPushover,
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

describe("Pushover client", () => {
  it("sends the translation and Slack URL without leaking secrets into the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 1 }), { status: 200 }));
    globalThis.fetch = fetchMock;

    await sendPushover("app-secret", "user-secret", {
      title: "Slack translation",
      message: "Translated text",
      url: "https://workspace.slack.com/message",
      urlTitle: "Open in Slack",
    }, 1000);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.pushover.net/1/messages.json");
    const body = init.body as URLSearchParams;
    expect(body.get("token")).toBe("app-secret");
    expect(body.get("user")).toBe("user-secret");
    expect(body.get("url")).toContain("slack.com");
  });

  it("throws when Pushover rejects a request", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 0 }), { status: 400 }));
    await expect(sendPushover("app", "user", {
      title: "Title",
      message: "Message",
    }, 1000)).rejects.toThrow("Pushover delivery failed");
  });
});
