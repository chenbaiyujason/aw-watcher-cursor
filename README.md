# aw-watcher-cursor

This extension allows [ActivityWatch](https://activitywatch.net), the free and open-source time tracker, to keep track of the files, projects and git milestones you go through in Cursor / VS Code.

The extension is published on [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=activitywatch.aw-watcher-vscode) and [Open VSX](https://open-vsx.org/extension/ActivityWatch/aw-watcher-vscode).

The source code is available at https://github.com/chenbaiyujason/aw-watcher-cursor

## Features

Sends the following data to ActivityWatch using dedicated buckets instead of a single mixed timeline:

- file activity segments in a single `app.editor.activity` track
- `activityKind` metadata on file activity events, so reading/dwelling (`dwell`) and active editing (`edit`) can still be distinguished without splitting into multiple buckets
- Git commit summary archive events with commit hash/title/description
- bottom-right `AW` connection status in Cursor / VS Code, with reconnect entrypoint and last-error inspection
- Cursor Hooks based agent lifecycle events, installed automatically into Cursor's global hooks directory
- current project name, current file path, language, workspace and Git branch metadata where relevant

The watcher uses heartbeats only for continuous file activity. Commit events are sent as discrete events, which keeps the editor timeline smooth and prevents milestone events from breaking heartbeat merges.

Currently VS Code extensions don't support getting file/project names for some non-editable files, therefore this can still result in the value `unknown` for those properties.

## Requirements

This extension requires ActivityWatch to be running on your machine.

## Install Instructions

To install this extension, search for `aw-watcher-vscode` in the Extensions sidebar in VS Code / Cursor and install the one with ActivityWatch as the publisher name. If ActivityWatch is running locally, it should detect the watcher automatically after the first few heartbeats.

## Commands

#### Reload ActivityWatch

Use this in case VS Code has been started before the AW server.

#### ActivityWatch Status

The extension now shows an `AW` status item in the bottom-right status bar:

- `AW 已连接`: local ActivityWatch is reachable and buckets are ready
- `AW 连接中`: the extension is probing/recovering the connection
- `AW 已断开`: local ActivityWatch is unreachable or bucket recreation failed

Click the status item to inspect the latest error and trigger a manual reconnect.

## Extension Settings

This extension adds the following settings:

- `aw-watcher-vscode.maxHeartbeatsPerSec`: Controls the maximum number of heartbeat refreshes sent per second for continuous signals.
- `aw-watcher-vscode.pulseTimeSec`: Legacy alias for `fileActivityPulseTimeSec`.
- `aw-watcher-vscode.fileActivityPulseTimeSec`: Controls how long adjacent file-activity heartbeats can merge into one segment.
- `aw-watcher-vscode.textChangeDebounceMs`: Debounces immediate text-change refreshes to reduce noise during rapid typing.
- `aw-watcher-vscode.enableCommitArchive`: Enable or disable git commit summary reporting.
- `aw-watcher-vscode.commitBackfillCount`: Number of recent commits to backfill on startup.
- `aw-watcher-vscode.includeAuthorPII`: Whether to include commit author name/email.

## Cursor Hooks

Cursor agent events are no longer inferred inside the extension host. They are emitted by Cursor Hooks, and the extension now auto-installs the bundled hook files into the global Cursor hooks directory on activation.

Global install paths:

- macOS: `/Library/Application Support/Cursor/hooks.json`
- Linux / WSL: `/etc/cursor/hooks.json`
- Windows: `C:\ProgramData\Cursor\hooks.json`

The hook scripts are installed alongside `hooks.json` in the matching global `hooks/` directory. The bundled source files still live in this repository under `.cursor/hooks.json` and `.cursor/hooks/`, but users no longer need to copy them manually.

The included hook setup reports one event type into `com.activitywatch.cursor.agent.lifecycle`:

- `beforeSubmitPrompt`: one `before_submit_prompt` event for each submitted user message

Each event contains:

- `conversationId`: conversation-level identifier
- `workspaceRoots`: current workspace root list
- `body`: full submitted user text

The hook implementation lives in `.cursor/hooks/agent-report.cjs`.
<!--
TODO:
* `aw-watcher-vscode.enable`: enable/disable this extension
-->

## Reporting scripts

You can generate JSON reports from local ActivityWatch data:

- `npm run report:project` - file activity report with project/file/language aggregates and `activityKind` counts
- `npm run report:agent` - Cursor agent activity report generated from Cursor Hooks data
- `npm run report:commits` - full commit archive report with query indexes

You can also push a recent synthetic timeline into a local ActivityWatch instance for UI validation:

- `npm run push:test-timeline`

Optional flags:

- `--hours=<number>` lookback window (default: 24)
- `--output=<path>` output file path

For detailed bucket schemas, trigger rules and report fields, see [`docs/reporting.md`](docs/reporting.md).

## Error reporting

If you run into any errors or have feature requests, please [open an issue](https://github.com/ActivityWatch/aw-watcher-vscode).

<!--
## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.
-->

## Release Notes

### 1.0.0

- Added the bottom-right `AW` connection status item with connected / connecting / disconnected states.
- Added bundled Cursor Hooks auto-installation and agent lifecycle reporting.
- Removed the legacy `0.7.0` package and refreshed release packaging for `1.0.0`.

### 0.5.0

 - Updated publisherId to `activitywatch`.
 - Added support for VSCodium.
 - Added support for VSCode remote.

### 0.4.1

Updated aw-client-js, media and npm dependencies.

### 0.4.0

Updated submodules aw-client-js and media to latest

fixed the extension to work with the latest aw-client:
- AppEditorActivityHeartbeat --> IAppEditorEvent
- createBucket --> ensureBucket
- options object in AWClient constructor
- timestamp should be a Date not a string

### 0.3.3

Fixed security vulnerability of an outdated dependency.

### 0.3.2

Added `maxHeartbeatsPerSec` configuration.

### 0.3.0

Refined error handling and heartbeat logic.

### 0.2.0

Refined error handling and README.

### 0.1.0

Initial release of aw-watcher-vscode.
