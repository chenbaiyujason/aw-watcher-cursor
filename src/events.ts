import { IEvent } from '../aw-client-js/src/aw-client';

// 统一的 watcher client 名称，便于多个脚本共享 bucket 约定。
export const WATCHER_CLIENT_NAME = 'aw-watcher-vscode';

// 沿用 ActivityWatch 官方 app.editor.activity 类型，文件活动统一走此 bucket。
export const BUCKET_EVENT_TYPE_FILE_ACTIVITY = 'app.editor.activity';
export const BUCKET_EVENT_TYPE_AGENT_LIFECYCLE = 'com.activitywatch.cursor.agent.lifecycle';
export const BUCKET_EVENT_TYPE_GIT_COMMIT = 'com.activitywatch.cursor.git.commit';

export const BUCKET_SUFFIX_FILE_ACTIVITY = 'file-activity';
export const BUCKET_SUFFIX_AGENT = 'agent';
export const BUCKET_SUFFIX_COMMIT = 'git-commit';

// 通用上下文，所有事件共享相同的项目语义。
export interface ICommonEventContext {
    project: string;
    file: string;
    language: string;
    branch: string;
    workspaceId: string;
}

// 文件活动类型：在单轨模型里区分“停留阅读”与“实际编辑”。
export type FileActivityKind = 'dwell' | 'edit';

// 文件活动事件：查看和编辑统一上报同一条轨道，由 heartbeat 自然合并成连续时间段。
export interface IFileActivityEventData {
    project: string;
    file: string;
    language: string;
    branch: string;
    workspaceId: string;
    activityKind: FileActivityKind;
}

// Agent 任务类型，用于统计分布。
export type AgentTaskKind = 'explain' | 'fix' | 'refactor' | 'test_gen' | 'ask' | 'unknown';

// Agent 事件名称，覆盖基础生命周期。
export type AgentEventName = 'panel_open' | 'task_start' | 'task_end' | 'patch_apply' | 'patch_reject' | 'agent_command';

// Agent 事件数据。
export interface IAgentEventData extends ICommonEventContext {
    eventName: AgentEventName;
    taskKind: AgentTaskKind;
    source: 'shortcut' | 'command_palette' | 'context_menu' | 'unknown';
    outcome: 'accepted' | 'rejected' | 'partial' | 'success' | 'failed' | 'unknown';
    sessionId: string;
    commandId: string;
    mappingVersion: string;
    selectedChars: number;
    touchedFiles: number;
    deltaAdded: number;
    deltaDeleted: number;
    latencyMs: number;
}

// Commit 归档事件数据，保持轻量，具体文件变更由 hash 再查 git。
export interface ICommitArchiveEventData extends ICommonEventContext {
    eventName: 'commit_summary';
    commitHashFull: string;
    parentHashes: string[];
    repoPath: string;
    authorName: string;
    authorEmail: string;
    authorDate: string;
    commitDate: string;
    subject: string;
    body: string;
    relatedAgentSessionId: string;
}

// bucket 定义帮助扩展与报表共用统一常量。
export interface IBucketDefinition {
    suffix: string;
    eventType: string;
}

// 三类 bucket：文件活动（连续）、agent（离散）、commit（离散里程碑）。
export const BUCKET_DEFINITIONS: {
    fileActivity: IBucketDefinition;
    agentLifecycle: IBucketDefinition;
    gitCommit: IBucketDefinition;
} = {
    fileActivity: {
        suffix: BUCKET_SUFFIX_FILE_ACTIVITY,
        eventType: BUCKET_EVENT_TYPE_FILE_ACTIVITY
    },
    agentLifecycle: {
        suffix: BUCKET_SUFFIX_AGENT,
        eventType: BUCKET_EVENT_TYPE_AGENT_LIFECYCLE
    },
    gitCommit: {
        suffix: BUCKET_SUFFIX_COMMIT,
        eventType: BUCKET_EVENT_TYPE_GIT_COMMIT
    }
};

// 统一构造文件活动事件，查看和编辑共用同一 builder。
export function createFileActivityEvent(data: IFileActivityEventData): IEvent<IFileActivityEventData> {
    return {
        timestamp: new Date(),
        duration: 0,
        data
    };
}

// 统一构造 Agent 事件，避免散落拼字段。
export function createAgentEvent(data: IAgentEventData): IEvent<IAgentEventData> {
    return {
        timestamp: new Date(),
        duration: 0,
        data
    };
}

// Commit 作为里程碑事件，默认 60 秒让时间线上更显眼。
export function createCommitArchiveEvent(data: ICommitArchiveEventData): IEvent<ICommitArchiveEventData> {
    return {
        timestamp: new Date(),
        duration: 60,
        data
    };
}

// 统一生成 bucketId，确保 watcher 与报表脚本使用同一命名规则。
export function createBucketId(bucketSuffix: string, hostName: string): string {
    return `${WATCHER_CLIENT_NAME}-${bucketSuffix}_${hostName}`;
}

// 生成会话 ID，便于上层按会话聚合。
export function createSessionId(prefix: string): string {
    const timePart = Date.now().toString(36);
    const randomPart = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${timePart}_${randomPart}`;
}
