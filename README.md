# aw-watcher-cursor

This extension allows [ActivityWatch](https://activitywatch.net), the free and open-source time tracker, to keep track of the files, projects, agent actions and git milestones you go through in Cursor / VS Code.

The extension is published on [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=activitywatch.aw-watcher-vscode) and [Open VSX](https://open-vsx.org/extension/ActivityWatch/aw-watcher-vscode).

The source code is available at https://github.com/chenbaiyujason/aw-watcher-cursor

## Features

Sends the following data to ActivityWatch using dedicated buckets instead of a single mixed timeline:

- file focus dwell segments, so you can see how long you stayed on a file
- file editing segments, so you can separate real typing time from reading time
- project presence segments, so cross-file work still looks continuous on the timeline
- Cursor Agent activity events (panel open, task start/end, patch apply/reject, fallback command capture)
- Git commit summary archive events with commit hash/title/description
- current project name, current file path, language, workspace and Git branch metadata where relevant

The watcher uses heartbeats only for continuous signals such as file focus, file editing and project presence. Agent and commit events are sent as discrete events, which keeps the editor timeline smooth and prevents milestone events from breaking heartbeat merges.

Currently VS Code extensions don't support getting file/project names for some non-editable files, therefore this can still result in the value `unknown` for those properties.

## Requirements

This extension requires ActivityWatch to be running on your machine.

## Install Instructions

To install this extension, search for `aw-watcher-vscode` in the Extensions sidebar in VS Code / Cursor and install the one with ActivityWatch as the publisher name. If ActivityWatch is running locally, it should detect the watcher automatically after the first few heartbeats.

## Commands

#### Reload ActivityWatch

Use this in case VS Code has been started before the AW server.

## Extension Settings

This extension adds the following settings:

- `aw-watcher-vscode.maxHeartbeatsPerSec`: Controls the maximum number of heartbeat refreshes sent per second for continuous signals.
- `aw-watcher-vscode.pulseTimeSec`: Legacy alias for the file editing heartbeat merge window.
- `aw-watcher-vscode.fileEditingPulseTimeSec`: Controls how long adjacent text-editing heartbeats can merge into one editing segment.
- `aw-watcher-vscode.fileFocusPulseTimeSec`: Controls how long adjacent file-focus heartbeats can merge into one dwell segment.
- `aw-watcher-vscode.projectPresencePulseTimeSec`: Controls how long adjacent project-presence heartbeats can merge into one project segment.
- `aw-watcher-vscode.editingIdleTimeoutSec`: Keeps editing active for a short period after the last text change so intermittent typing still looks continuous.
- `aw-watcher-vscode.textChangeDebounceMs`: Debounces immediate text-change refreshes to reduce noise during rapid typing.
- `aw-watcher-vscode.enableAgentReport`: Enable or disable Cursor agent activity reporting.
- `aw-watcher-vscode.enableCommitArchive`: Enable or disable git commit summary reporting.
- `aw-watcher-vscode.commitBackfillCount`: Number of recent commits to backfill on startup.
- `aw-watcher-vscode.includeAuthorPII`: Whether to include commit author name/email.
- `aw-watcher-vscode.mappingVersion`: Agent command mapping version tag.
- `aw-watcher-vscode.agentCommandMapping`: Command mapping object for agent lifecycle events.
<!--
TODO:
* `aw-watcher-vscode.enable`: enable/disable this extension
-->

## Reporting scripts

You can generate JSON reports from local ActivityWatch data:

- `npm run report:project` - file focus, file editing and project presence report
- `npm run report:agent` - Cursor agent activity report
- `npm run report:commits` - full commit archive report with query indexes

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
