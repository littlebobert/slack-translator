export interface RelayConfig {
  slackUserId: string;
  slackUserTokenEnv: string;
  pushoverUserKeyEnv: string;
  pushoverAppTokenEnv: string;
  notificationTitle: string;
  maxConcurrency: number;
  dedupeTtlSeconds: number;
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
  metadata?: Record<string, unknown>;
}

export interface RelayMessage {
  channelId: string;
  messageTs: string;
  senderId: string;
  senderName?: string;
  text: string;
  isDirect: boolean;
}

export interface SlackIdentity {
  displayName: string;
}

export interface RelayDependencies {
  translate(text: string): Promise<string>;
  getPermalink(channelId: string, messageTs: string): Promise<string | undefined>;
  getSenderName(senderId: string): Promise<string | undefined>;
  sendPush(input: PushInput): Promise<void>;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface PushInput {
  title: string;
  message: string;
  url?: string;
  urlTitle?: string;
}
