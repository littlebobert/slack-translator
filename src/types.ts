export interface RelayConfig {
  slackUserId: string;
  slackUserTokenEnv: string;
  notifyAllChannelIds: string[];
  imessageRecipient: string;
  imsgCliPath: string;
  notificationTitle: string;
  maxConcurrency: number;
  dedupeTtlSeconds: number;
  presenceCacheSeconds: number;
  requestTimeoutMs: number;
}

export interface InboundSlackMessage {
  channel: string;
  conversationId?: string;
  content: string;
  senderId?: string;
  senderName?: string;
  messageId?: string;
  timestamp?: number;
  isGroup: boolean;
  wasMentioned?: boolean;
  threadId?: string;
  metadata?: Record<string, unknown>;
}

export interface RelayMessage {
  channelId: string;
  messageTs: string;
  senderId: string;
  senderName?: string;
  text: string;
  isDirect: boolean;
  isThreadReply: boolean;
  isChannelNotification: boolean;
}

export interface SlackIdentity {
  displayName: string;
}

export interface RelayDependencies {
  translate(text: string): Promise<string>;
  getPermalink(channelId: string, messageTs: string): Promise<string | undefined>;
  getSenderName(senderId: string): Promise<string | undefined>;
  sendNotification(input: NotificationInput): Promise<void>;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface NotificationInput {
  title: string;
  message: string;
  url?: string;
  urlTitle?: string;
}
