import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NotificationInput } from "./types.js";

const execFileAsync = promisify(execFile);

interface FetchOptions {
  timeoutMs: number;
  retries?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchOptions,
): Promise<Response> {
  const retries = options.retries ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < retries) await sleep(250 * 2 ** attempt);
  }
  throw lastError instanceof Error ? lastError : new Error("Request failed");
}

async function slackApi<T extends Record<string, unknown>>(
  method: string,
  token: string,
  params: URLSearchParams,
  timeoutMs: number,
): Promise<T> {
  const response = await fetchWithRetry(`https://slack.com/api/${method}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, { timeoutMs });
  const result = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || result.ok !== true) {
    throw new Error(`Slack ${method} failed: ${result.error ?? response.status}`);
  }
  return result;
}

export async function getSlackPermalink(
  token: string,
  channelId: string,
  messageTs: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const result = await slackApi<{ permalink?: string }>(
    "chat.getPermalink",
    token,
    new URLSearchParams({ channel: channelId, message_ts: messageTs }),
    timeoutMs,
  );
  return result.permalink;
}

export type SlackPresence = "active" | "away";

export class SlackPresenceCache {
  private cached: { presence: SlackPresence; expiresAt: number } | undefined;
  private pending: Promise<SlackPresence> | undefined;

  constructor(
    private readonly token: string,
    private readonly userId: string,
    private readonly timeoutMs: number,
    private readonly ttlMs = 30_000,
  ) {}

  async getPresence(): Promise<SlackPresence> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.presence;
    if (this.pending) return this.pending;

    this.pending = slackApi<{ presence?: string }>(
      "users.getPresence",
      this.token,
      new URLSearchParams({ user: this.userId }),
      this.timeoutMs,
    ).then((result) => {
      if (result.presence !== "active" && result.presence !== "away") {
        throw new Error("Slack users.getPresence returned an invalid presence");
      }
      this.cached = { presence: result.presence, expiresAt: Date.now() + this.ttlMs };
      return result.presence;
    }).finally(() => {
      this.pending = undefined;
    });

    return this.pending;
  }
}

export class SlackUserCache {
  private readonly entries = new Map<string, { name: string; expiresAt: number }>();

  constructor(
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly ttlMs = 15 * 60_000,
  ) {}

  async getDisplayName(userId: string): Promise<string | undefined> {
    const cached = this.entries.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.name;
    const result = await slackApi<{
      user?: { real_name?: string; name?: string; profile?: { display_name?: string; real_name?: string } };
    }>("users.info", this.token, new URLSearchParams({ user: userId }), this.timeoutMs);
    const user = result.user;
    const name = user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name;
    if (name) this.entries.set(userId, { name, expiresAt: Date.now() + this.ttlMs });
    return name;
  }
}

export async function sendIMessage(
  cliPath: string,
  recipient: string,
  input: NotificationInput,
  timeoutMs: number,
): Promise<void> {
  const text = [
    input.title,
    input.message,
    ...(input.url ? [`Link: ${input.url}`] : []),
  ].join("\n");
  try {
    await execFileAsync(cliPath, ["send", "--to", recipient, "--text", text], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error("iMessage delivery failed", { cause: error });
  }
}
