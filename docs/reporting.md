# Reporting Specification

This document describes the reporting model for `aw-watcher-vscode`.

## Buckets

- `app.editor.activity`
  - Continuous heartbeat bucket for unified file activity in Cursor / VS Code.
  - Reading / dwell and active editing are both stored here, distinguished by `activityKind`.
- `com.activitywatch.cursor.agent.lifecycle`
  - Discrete Cursor Agent lifecycle events.
- `com.activitywatch.cursor.git.commit`
  - Discrete git commit summary archive events.

## Event Schema

All events follow the ActivityWatch schema:

- `timestamp`: ISO time
- `duration`: `0` for heartbeat events, `60` for commit marker events
- `data`: event payload

### File Activity Event Data

- `project`
- `file`
- `language`
- `branch`
- `workspaceId`
- `activityKind` (`dwell` | `edit`)

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

### File Activity Events

- Active editor changed.
- Selection changed.
- Timer heartbeat while the same file remains active and the window stays focused.
- `workspace.onDidChangeTextDocument` refreshes the file activity and marks the activity as `edit`.
- Save refreshes the file activity and also marks the activity as `edit`.
- A short edit idle window keeps adjacent heartbeats labeled as `edit` for a few seconds after the last text change.
- File switches or `activityKind` changes create a new merged segment because the heartbeat `data` changes.
- Window blur stops future file activity heartbeats until focus returns.

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
- Reading and editing share one bucket, but `activityKind` keeps them distinguishable without requiring multiple continuous tracks.

## Reporting Scripts

- `npm run report:project`
  - Outputs file activity aggregates for `project`, `file`, `language` and `activityKind`.
  - Includes both event counts and total merged duration in seconds.
- `npm run report:agent`
  - Outputs aggregate counts by event/task kind/outcome/command.
- `npm run report:commits`
  - Outputs `project -> commits`, `commitHash -> summary`, `agentSession -> commits` indexes.

## Test Timeline Script

- `npm run push:test-timeline`
  - Rebuilds dedicated test buckets in a local ActivityWatch instance.
  - Pushes a recent synthetic Cursor timeline using the same bucket names, event schema and timing defaults as the extension.
  - The synthetic file activity timeline can include both `dwell` and `edit` segments inside the same `app.editor.activity` bucket.

Both scripts support:

- `--hours=<number>`
- `--output=<path>`

## Privacy Boundary

The watcher only reports metadata and counters.
It does not collect prompt text or source file contents by default.
Commit archive stores summary metadata only (hash/title/description), not full diff.