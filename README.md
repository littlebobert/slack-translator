# Slack Translation Relay

An OpenClaw plugin for a Mac mini that watches Slack as an approved user identity. While Slack reports you active, it stays quiet. While Slack reports you away, it forwards DMs and channel mentions to Pushover, translating Japanese messages with OpenClaw's configured model and passing other languages through unchanged. Notifications include a link to the exact Slack message. The plugin never replies in Slack.

## Security and workspace approval

This integration uses Slack's supported user-scoped Events API. It does not copy cookies, scrape the Slack UI, or hide its access. Your Slack workspace administrator must approve the app and its access to your DMs and channel history. Confirm that sending work-message text to OpenClaw's configured model and Pushover complies with your employer's policies.

Socket Mode opens an outbound WebSocket from the Mac mini, so no public inbound endpoint is required.

## Prerequisites

- OpenClaw `2026.5.17` or newer running on the Mac mini
- Permission to install or request approval for a Slack app
- A [Pushover](https://pushover.net/) account, mobile app, user key, and application API token
- The Mac mini configured to stay awake and restart OpenClaw after reboot

## 1. Create the Slack app

1. Open [Slack API Apps](https://api.slack.com/apps), choose **Create New App**, and create it from [`config/slack-app-manifest.json`](config/slack-app-manifest.json).
2. Ask a workspace administrator to review and approve the user scopes.
3. Under **Basic Information → App-Level Tokens**, generate a token with only `connections:write`. This is the `xapp-…` token.
4. Install or reinstall the app to the workspace as your Slack account. Copy the resulting `xoxp-…` user OAuth token.
5. Find your Slack member ID from your Slack profile menu. It starts with `U`.

The app requests read-only user scopes. It intentionally omits `chat:write`, so neither OpenClaw nor this plugin can post as you through this app.

## 2. Install the OpenClaw Slack channel

```bash
openclaw plugins install @openclaw/slack
```

Configure the Slack channel in `~/.openclaw/openclaw.json`. Use secret references supported by your OpenClaw installation when possible; the environment-variable form below is concise and keeps tokens out of the file.

```json5
{
  channels: {
    slack: {
      enabled: true,
      identity: "user",
      mode: "socket",
      userToken: { source: "env", provider: "default", id: "SLACK_USER_TOKEN" },
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      userTokenReadOnly: true,
    },
  },
}
```

## 3. Install this plugin

From this repository:

```bash
npm install
npm test
npm run build
npm pack
openclaw plugins install npm-pack:./openclaw-slack-translation-relay-0.1.0.tgz --force
```

Add the plugin entry to `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "slack-translation-relay": {
        enabled: true,
        config: {
          slackUserId: "U0123456789",
          slackUserTokenEnv: "SLACK_USER_TOKEN",
          pushoverUserKeyEnv: "PUSHOVER_USER_KEY",
          pushoverAppTokenEnv: "PUSHOVER_APP_TOKEN",
          notificationTitle: "Slack while away",
          maxConcurrency: 2,
          dedupeTtlSeconds: 3600,
          presenceCacheSeconds: 30,
          requestTimeoutMs: 10000,
        },
      },
    },
  },
}
```

Set these secrets in the environment used by the OpenClaw service, not only in an interactive terminal:

```bash
SLACK_USER_TOKEN=xoxp-your-user-token
SLACK_APP_TOKEN=xapp-your-socket-token
PUSHOVER_USER_KEY=your-pushover-user-key
PUSHOVER_APP_TOKEN=your-pushover-application-token
```

Restart and inspect the runtime:

```bash
openclaw gateway restart
openclaw plugins inspect slack-translation-relay --runtime --json
```

## Behavior

A notification is sent only when all of these are true:

- the inbound provider is Slack;
- Slack's `users.getPresence` API reports your account as `away`;
- the sender is not your own Slack user ID;
- the event is an ordinary message, not an edit, deletion, bot, or system event;
- it is a DM to you, or a channel/private-channel message that mentions you.

Japanese text containing Hiragana, Katakana, or Han characters is translated into English. Other text is forwarded unchanged and does not invoke the model. Presence is cached for 30 seconds by default to limit Slack API traffic. Slack normally marks a desktop user away after roughly 10 minutes without activity; locking the desktop generally transitions mobile notification timing sooner.

The event is claimed silently so OpenClaw does not answer in Slack. Slack retries are deduplicated by conversation ID and message timestamp. Model, Slack API, and Pushover failures are retried with bounded timeouts. If Japanese translation fails, the plugin sends a short failure notification with the Slack link when available. If the presence check fails, the plugin fails closed and sends no push, avoiding duplicate alerts while your state is unknown.

Pushover messages are truncated to its 1,024-byte limit. Message bodies and credentials are never written to plugin logs.

## Validation checklist

After restarting OpenClaw, test these cases:

1. While Slack shows you active, receive a DM or mention: no Pushover notification arrives.
2. Set your Slack availability to away for testing, then receive a Japanese DM: one translated push arrives.
3. While away, receive an English DM: one unchanged push arrives without a model translation.
4. While away, receive a Japanese channel mention: one translated push arrives.
5. A channel message that does not mention you produces no push.
6. Open the notification: Slack opens the exact original message.
7. Restart the network briefly and confirm a retried Slack event produces at most one push.
8. Return Slack availability to automatic when testing is complete.

## Turn off Slack notifications on the phone

Do this only after the validation checklist passes:

1. Open Slack on the phone and tap your profile picture.
2. Open **Notifications**.
3. Turn **Mobile notifications** off for the workspace.
4. Keep Pushover notifications enabled in iOS or Android settings.

Slack does not expose an API that lets this plugin dynamically disable Slack's own mobile pushes. Disabling Slack mobile notifications avoids duplicates; Pushover becomes the away-mode notification channel, while the Slack app remains available for opening message links and replying.

## Troubleshooting

- **No push while away:** confirm Slack actually shows your account as away. Automatic away normally takes about 10 minutes of desktop inactivity; manually choose away to test immediately.
- **Unexpected push while at the laptop:** presence can remain cached for up to `presenceCacheSeconds` after Slack changes state. Reduce it to 5 seconds for testing, then use 30 seconds normally.
- **No Slack events:** confirm the app uses user event subscriptions, Socket Mode is enabled, the `xapp` token has `connections:write`, and the app was reinstalled after scopes changed.
- **`missing_scope`:** compare the installed app's user scopes with [`config/slack-app-manifest.json`](config/slack-app-manifest.json), then reinstall it.
- **No translation:** verify OpenClaw's default agent has a working configured model.
- **No push:** verify both Pushover secrets and check account delivery limits.
- **Link missing:** ensure the installed user token can access the source conversation and message.
