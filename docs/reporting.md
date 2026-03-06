# Reporting Specification

This document describes the reporting model for `aw-watcher-vscode`.

## Buckets

- `com.activitywatch.cursor.file-focus`
  - Continuous heartbeat bucket for file dwell / focus time.
- `app.editor.activity`
  - Continuous heartbeat bucket for real file editing time.
- `com.activitywatch.cursor.project-presence`
  - Continuous heartbeat bucket for cross-file project activity.
- `com.activitywatch.cursor.agent.lifecycle`
  - Discrete Cursor Agent lifecycle events.
- `com.activitywatch.cursor.git.commit`
  - Discrete git commit summary archive events.

## Event Schema

All events follow the ActivityWatch schema:

- `timestamp`: ISO time
- `duration`: `0` for heartbeat events, `60` for commit marker events
- `data`: event payload

### File Focus Event Data

- `project`
- `file`
- `language`
- `eventName` (`file_focus`)
- `mode` (`focus`)

### File Editing Event Data

- `project`
- `file`
- `language`
- `eventName` (`file_editing`)
- `mode` (`editing`)

### Project Presence Event Data

- `project`
- `branch`
- `workspaceId`
- `eventName` (`project_presence`)
- `mode` (`active`)

### Agent Event Data

- `project`
- `file`
- `language`
- `branch`
- `workspaceId`
- `eventName` (`panel_open` | `task_start` | `task_end` | `patch_apply` | `patch_reject`)
- `taskKind` (`explain` | `fix` | `refactor` | `test_gen` | `ask` | `unknown`)
- `source` (`shortcut` | `command_palette` | `context_menu` | `unknown`)
- `outcome` (`accepted` | `rejected` | `partial` | `success` | `failed` | `unknown`)
- `sessionId`
- `commandId`
- `mappingVersion`
- `selectedChars`
- `touchedFiles`
- `deltaAdded`
- `deltaDeleted`
- `latencyMs`

### Commit Archive Event Data

- `eventName` (`commit_summary`)
- `commitHashFull` (40-char hash)
- `parentHashes`
- `repoPath`
- `project`
- `branch`
- `authorName`
- `authorEmail`
- `authorDate`
- `commitDate`
- `subject`
- `body`
- `relatedAgentSessionId`

## Trigger Conditions

### File Focus Events

- Active editor changed.
- Selection changed.
- Timer heartbeat while the same file remains focused and the window stays active.
- Window blur stops future focus heartbeats.

### File Editing Events

- `workspace.onDidChangeTextDocument` starts or refreshes the editing window.
- Timer heartbeat keeps the file editing segment alive until `editingIdleTimeoutSec` is exceeded.
- File switches create a new editing segment because the heartbeat `data` changes.

### Project Presence Events

- Any active file focus or file editing activity refreshes project presence.
- Cross-file work keeps merging as long as `project`, `workspaceId` and `branch` remain identical.

### Agent Events

- `commands.onDidExecuteCommand` is mapped to lifecycle events.
- Agent events are inserted as discrete events, not heartbeats.

### Commit Events

- Triggered on repository HEAD change (`repository.state.onDidChange`).
- Backfills recent commits at startup (`commitBackfillCount`).
- Commit events are inserted as discrete 60-second markers.
- Detailed file changes are not stored; use `commitHashFull` to query git on demand.

### Noise Filtering

- Continuous editor events are recorded only for `file://` documents.
- Cursor internal virtual tabs (`tasks`, `review`, logs) are excluded from editor heartbeat.
- Pure reading time and pure typing time are stored separately, so dwell does not inflate editing duration.

## Reporting Scripts

- `npm run report:project`
  - Outputs separate aggregates for `fileFocus`, `fileEditing` and `projectPresence`.
  - Includes both event counts and total merged duration in seconds.
- `npm run report:agent`
  - Outputs aggregate counts by event/task kind/outcome/command.
- `npm run report:commits`
  - Outputs `project -> commits`, `commitHash -> summary`, `agentSession -> commits` indexes.

Both scripts support:

- `--hours=<number>`
- `--output=<path>`

## Privacy Boundary

The watcher only reports metadata and counters.
It does not collect prompt text or source file contents by default.
Commit archive stores summary metadata only (hash/title/description), not full diff.