# Slack Translation Relay

An OpenClaw plugin for a Mac mini that watches Slack as an approved user identity. While Slack reports you active, it stays quiet. While Slack reports you away, it forwards DMs and channel mentions through iMessage, translating Japanese messages with OpenClaw's configured model and passing other languages through unchanged. Each iMessage includes a link to the exact Slack message. The plugin never replies in Slack.

## Security and workspace approval

This integration uses Slack's supported user-scoped Events API. It does not copy cookies, scrape the Slack UI, or hide its access. Your Slack workspace administrator must approve the app and its access to your DMs and channel history. Confirm that sending work-message text to OpenClaw's configured model and iMessage complies with your employer's policies.

Socket Mode opens an outbound WebSocket from the Mac mini, so no public inbound endpoint is required.

## Prerequisites

- OpenClaw `2026.5.17` or newer running on the Mac mini
- Permission to install or request approval for a Slack app
- Messages signed in on the Mac mini, with `imsg` installed and allowed to automate Messages
- An iMessage-capable phone number or Apple Account email to receive relayed messages
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
      postAs: "user",
      mode: "socket",
      userToken: { source: "env", provider: "default", id: "SLACK_USER_TOKEN" },
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      userTokenReadOnly: true,
    },
  },
}
```

## 3. Set up iMessage delivery

The relay invokes [`imsg`](https://github.com/steipete/imsg) directly on the Mac mini. Messages.app must be signed in and able to send an iMessage to the configured recipient.

1. Confirm `imsg` is installed at `/opt/homebrew/opt/imsg/bin/imsg`, or record its actual path with `command -v imsg`.
2. Grant **Full Disk Access** and **Automation → Messages** permission to the process context that runs OpenClaw and `imsg`.
3. In an interactive terminal on the Mac mini, test the exact recipient before configuring the plugin:

```bash
/opt/homebrew/opt/imsg/bin/imsg send "+15555550123" "OpenClaw iMessage test"
```

Use the receiving iPhone's full E.164 phone number, such as `+15555550123`, or its iMessage-enabled Apple Account email. Sending from and to the same Apple Account can behave differently depending on Messages routing and synchronization; verify that the test appears on the phone and generates the desired notification. A distinct receiving handle is more predictable.

Basic outbound text uses normal Messages automation and does not require the optional private API bridge or disabling SIP. iMessage content is end-to-end encrypted in transit. Consider enabling Advanced Data Protection for iCloud to strengthen protection for Messages-related cloud backups where available.

## 4. Install this plugin

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
          imessageRecipient: "+15555550123",
          imsgCliPath: "/opt/homebrew/opt/imsg/bin/imsg",
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
```

Restart and inspect the runtime:

```bash
openclaw gateway restart
openclaw plugins inspect slack-translation-relay --runtime --json
```

## Behavior

An iMessage is sent only when all of these are true:

- the inbound provider is Slack;
- Slack's `users.getPresence` API reports your account as `away`;
- the event is an ordinary message, not an edit, deletion, bot, or system event;
- it is a DM to you, or a channel/private-channel message that mentions you.

Japanese text containing Hiragana, Katakana, or Han characters is translated into English. Other text is forwarded unchanged and does not invoke the model. Presence is cached for 30 seconds by default to limit Slack API traffic. Slack normally marks a desktop user away after roughly 10 minutes without activity; locking the desktop generally transitions mobile notification timing sooner.

The event is claimed silently so OpenClaw does not answer in Slack. Slack retries are deduplicated by conversation ID and message timestamp. Model and Slack API calls use bounded retries and timeouts; `imsg` delivery has a bounded timeout. If Japanese translation fails, the plugin sends a short failure message with the Slack link when available. If the presence check fails, the plugin fails closed and sends no iMessage, avoiding duplicate alerts while your state is unknown.

The iMessage body includes the configured title, translated or unchanged message, and Slack permalink. Long bodies are truncated to 8,000 UTF-8 bytes. Message bodies and credentials are never written to plugin logs.

## Validation checklist

After restarting OpenClaw, test these cases:

1. While Slack shows you active, receive a DM or mention: no relay iMessage arrives.
2. Set your Slack availability to away for testing, then receive a Japanese DM from another Slack user: one translated iMessage arrives.
3. While away, receive an English DM: one unchanged iMessage arrives without a model translation.
4. While away, receive a Japanese channel mention: one translated iMessage arrives.
5. A channel message that does not mention you produces no iMessage.
6. Tap the Slack permalink in the iMessage: Slack opens the exact original message.
7. Restart the network briefly and confirm a retried Slack event produces at most one iMessage.
8. Return Slack availability to automatic when testing is complete.

## Turn off Slack notifications on the phone

Do this only after the validation checklist passes:

1. Open Slack on the phone and tap your profile picture.
2. Open **Notifications**.
3. Turn **Mobile notifications** off for the workspace.
4. Keep Messages notifications enabled in iOS settings.

Slack does not expose an API that lets this plugin dynamically disable Slack's own mobile pushes. Disabling Slack mobile notifications avoids duplicates; iMessage becomes the away-mode notification channel, while the Slack app remains available for opening message links and replying.

## Troubleshooting

- **No iMessage while away:** confirm Slack actually shows your account as away. Automatic away normally takes about 10 minutes of desktop inactivity; manually choose away to test immediately.
- **Unexpected iMessage while at the laptop:** presence can remain cached for up to `presenceCacheSeconds` after Slack changes state. Reduce it to 5 seconds for testing, then use 30 seconds normally.
- **No Slack events:** confirm the app uses user event subscriptions, Socket Mode is enabled, the `xapp` token has `connections:write`, and the app was reinstalled after scopes changed.
- **`missing_scope`:** compare the installed app's user scopes with [`config/slack-app-manifest.json`](config/slack-app-manifest.json), then reinstall it.
- **No translation:** verify OpenClaw's default agent has a working configured model.
- **`iMessage delivery failed`:** run the documented `imsg send` test as the same macOS user and GUI session as OpenClaw, then verify Full Disk Access and Messages Automation permissions. Confirm `imsgCliPath` and `imessageRecipient` are exact.
- **Link missing:** ensure the installed user token can access the source conversation and message.
