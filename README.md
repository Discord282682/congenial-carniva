# Hikari Android — Audited Build

Package/application ID: `com.charlesess6.hikari`

Compiled server base URL: `https://hikari-ai-server-t9lt.vercel.app`

## Correct message flow

Normal player input is never replaced by a heartbeat decision:

1. The player message is saved and sent once to `/api/chat`.
2. A successful AI result is rendered and its layered memory update is saved.
3. Only a real technical failure attempts the reciprocal relay.
4. If no eligible relay player is online, Hikari is shown offline and no fake reply is used.

Every 17th player turn, tapping the textbox may run one separate hidden availability pulse.
`YES` keeps AI chat active. `NO` creates a brief 30-second busy/relay window. The hidden word
is never displayed and never consumes the next player message.

## Autonomous messages

When the app is away, Android WorkManager may run no more frequently than its supported
15-minute interval. It first asks `/api/idle` for a hidden `YES` or `NO` decision:

- `NO`: nothing is sent.
- `YES`: a separate `/api/chat` autonomous request generates the actual Hikari message.

The generated message is persisted before a notification is shown. Hidden words such as
YES, NO, SEND, and WAIT are rejected as visible notifications. Android may delay background
work, especially under manufacturer battery restrictions, and force-stopping the app prevents
background work until it is opened again.

## Memory and files

- Layered RAM/summary/LTM/adaptive-persona memory is saved automatically per device.
- Current messages are sent once rather than repeated in several prompt sections.
- Ordinary chat does not upload local Hikari files.
- Selected `.txt` file contents are sent only for explicit file/note requests.
- Autonomous notes and edits remain limited to `Downloads/Hikari/`.
- Chat `.txt` attachments are written to the main Downloads folder only when opened.

## Reciprocal relay

- AI is attempted first during normal chat.
- A technical failure, or a current AI-selected busy window, may request one eligible online player.
- No lobby or player directory is exposed.
- An active relay conversation keeps text, voice, note, and file messages on the same session.
- **End Connection** ends the current session and forces AI-only attempts for seven minutes.
- Relay messages are assimilated into the owner's ordinary local memory.

Run the matching Supabase SQL from the server package. The fixed SQL no longer creates a
waiting session or stores a player message when nobody is actually available.

## Build in GitHub Codespaces

Upload the project contents to the repository root, commit, and push to `main`. GitHub Actions
runs automatically. Open **Actions**, select the latest successful run, and download the
`Hikari-Android-APK` artifact containing `app-debug.apk`.

The workflow caches a stable debug signing key and uses the GitHub run number as the Android
version code. An APK from an older, randomly signed workflow may need to be uninstalled once.
Subsequent builds from this repository should update normally while the signing-key cache remains.

## Local state

There are no visible Save/Load controls. Clearing application data or uninstalling removes local
conversation and memory unless Android restores an eligible backup. Do not uninstall casually.
