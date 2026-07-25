import type {
  InboundSlackMessage,
  PushInput,
  RelayConfig,
  RelayDependencies,
  RelayMessage,
} from "./types.js";

const JAPANESE_TEXT = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const SYSTEM_SUBTYPES = new Set([
  "bot_message",
  "channel_archive",
  "channel_join",
  "channel_leave",
  "channel_name",
  "channel_purpose",
  "channel_topic",
  "ekm_access_denied",
  "message_changed",
  "message_deleted",
  "thread_broadcast",
]);

export const PUSHOVER_MESSAGE_LIMIT = 1024;

export function containsJapanese(text: string): boolean {
  return JAPANESE_TEXT.test(text);
}

export function normalizeConfig(raw: Record<string, unknown>): RelayConfig {
  const stringValue = (key: string, fallback?: string): string => {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required plugin config: ${key}`);
  };
  const intValue = (key: string, fallback: number): number => {
    const value = raw[key];
    return typeof value === "number" && Number.isInteger(value) ? value : fallback;
  };

  return {
    slackUserId: stringValue("slackUserId"),
    slackUserTokenEnv: stringValue("slackUserTokenEnv", "SLACK_USER_TOKEN"),
    pushoverUserKeyEnv: stringValue("pushoverUserKeyEnv", "PUSHOVER_USER_KEY"),
    pushoverAppTokenEnv: stringValue("pushoverAppTokenEnv", "PUSHOVER_APP_TOKEN"),
    notificationTitle: stringValue("notificationTitle", "Slack while away"),
    maxConcurrency: intValue("maxConcurrency", 2),
    dedupeTtlSeconds: intValue("dedupeTtlSeconds", 3600),
    presenceCacheSeconds: intValue("presenceCacheSeconds", 30),
    requestTimeoutMs: intValue("requestTimeoutMs", 10_000),
  };
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value ? value : undefined;
}

export function isSystemMessage(message: InboundSlackMessage): boolean {
  const subtype = metadataString(message.metadata, "subtype");
  return subtype !== undefined && SYSTEM_SUBTYPES.has(subtype);
}

export function isDirectMessage(message: InboundSlackMessage): boolean {
  const channelId = message.conversationId ?? metadataString(message.metadata, "channelId") ?? "";
  const channelType = metadataString(message.metadata, "channelType")
    ?? metadataString(message.metadata, "channel_type");
  return !message.isGroup || channelType === "im" || channelId.startsWith("D");
}

export function isTargetedMessage(message: InboundSlackMessage, slackUserId: string): boolean {
  if (message.channel !== "slack" || isSystemMessage(message)) {
    return false;
  }
  if (isDirectMessage(message)) return true;
  return message.wasMentioned === true || message.content.includes(`<@${slackUserId}>`);
}

export function toRelayMessage(
  message: InboundSlackMessage,
  slackUserId: string,
): RelayMessage | undefined {
  if (!isTargetedMessage(message, slackUserId)) return undefined;

  const channelId = message.conversationId
    ?? metadataString(message.metadata, "channelId")
    ?? metadataString(message.metadata, "channel_id");
  const messageTs = message.messageId
    ?? metadataString(message.metadata, "messageTs")
    ?? metadataString(message.metadata, "ts")
    ?? (message.timestamp ? String(message.timestamp) : undefined);
  if (!channelId || !messageTs || !message.senderId) return undefined;

  const mentionPattern = new RegExp(`<@${escapeRegExp(slackUserId)}>`, "g");
  return {
    channelId,
    messageTs,
    senderId: message.senderId,
    ...(message.senderName ? { senderName: message.senderName } : {}),
    text: message.content.replace(mentionPattern, "").trim(),
    isDirect: isDirectMessage(message),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "…";
  const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
  let result = "";
  for (const character of text) {
    if (Buffer.byteLength(result + character, "utf8") > budget) break;
    result += character;
  }
  return result.trimEnd() + suffix;
}

export function buildPushInput(
  config: RelayConfig,
  message: RelayMessage,
  translation: string | undefined,
  permalink: string | undefined,
  resolvedSenderName?: string,
): PushInput {
  const sender = resolvedSenderName ?? message.senderName ?? message.senderId;
  const context = message.isDirect ? "DM" : "Mention";
  const body = translation
    ? `${context} from ${sender}\n\n${translation}`
    : `${context} from ${sender}\n\nTranslation failed. Open the original message in Slack.`;
  return {
    title: truncateUtf8(config.notificationTitle, 250),
    message: truncateUtf8(body, PUSHOVER_MESSAGE_LIMIT),
    ...(permalink ? { url: permalink, urlTitle: "Open in Slack" } : {}),
  };
}

export class TtlDeduplicator {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 5_000,
    private readonly now = () => Date.now(),
  ) {}

  accept(key: string): boolean {
    const current = this.now();
    this.prune(current);
    const expiresAt = this.entries.get(key);
    if (expiresAt !== undefined && expiresAt > current) return false;
    this.entries.set(key, current + this.ttlMs);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest) this.entries.delete(oldest);
    }
    return true;
  }

  private prune(current: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= current) this.entries.delete(key);
    }
  }
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  retries = 2,
  baseDelayMs = 250,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise<void>((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Operation failed");
}

export class WorkQueue {
  private active = 0;
  private readonly pending: Array<() => Promise<void>> = [];

  constructor(private readonly concurrency: number) {}

  enqueue(work: () => Promise<void>): void {
    this.pending.push(work);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency) {
      const work = this.pending.shift();
      if (!work) return;
      this.active += 1;
      void work().finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }
}

export async function processRelayMessage(
  config: RelayConfig,
  message: RelayMessage,
  dependencies: RelayDependencies,
): Promise<void> {
  const needsTranslation = containsJapanese(message.text);
  const [translationResult, permalinkResult, senderResult] = await Promise.allSettled([
    needsTranslation ? dependencies.translate(message.text) : Promise.resolve(message.text),
    dependencies.getPermalink(message.channelId, message.messageTs),
    dependencies.getSenderName(message.senderId),
  ]);

  const translation = translationResult.status === "fulfilled" ? translationResult.value : undefined;
  const permalink = permalinkResult.status === "fulfilled" ? permalinkResult.value : undefined;
  const senderName = senderResult.status === "fulfilled" ? senderResult.value : undefined;

  if (needsTranslation && !translation) dependencies.log("warn", "Translation failed; sending a fallback notification");
  if (!permalink) dependencies.log("warn", "Slack permalink lookup failed; sending without a link");

  await dependencies.sendPush(buildPushInput(config, message, translation, permalink, senderName));
}
