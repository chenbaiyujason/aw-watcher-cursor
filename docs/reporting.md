# Reporting Specification

This document describes the reporting model for `aw-watcher-vscode`.

## Buckets

- `app.editor.activity`
  - Single unified `vscode` tracker bucket for editor, agent and commit summary events.

## Event Schema

All events follow the ActivityWatch schema:

- `timestamp`: ISO time
- `duration`: `0` for heartbeat events
- `data`: event payload

### Project Event Data

- `project`
- `file`
- `language`
- `branch`
- `workspaceId`
- `editorSessionId`
- `trigger` (`selection` | `active-editor` | `periodic` | `manual`)

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

### Project Events

- Active editor changed.
- Selection changed.
- File save event.
- Periodic heartbeat window exceeded.
- File or branch changed.

### Agent Events

- `commands.onDidExecuteCommand` is mapped to lifecycle events:
  - panel open
  - task start/end
  - patch apply/reject

### Commit Events

- Triggered on repository HEAD change (`repository.state.onDidChange`).
- Backfills recent commits at startup (`commitBackfillCount`).
- Detailed file changes are not stored; use `commitHashFull` to query git on demand.

### Noise Filtering

- Editor events are recorded only for `file://` documents.
- Cursor internal virtual tabs (`tasks`, `review`, logs) are excluded from editor heartbeat.

## Reporting Scripts

- `npm run report:project`
  - Outputs aggregate counts by project/language/file/branch.
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