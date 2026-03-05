import { IEvent } from '../aw-client-js/src/aw-client';

// AW bucket 的类型常量，保证上报事件语义稳定。
export const BUCKET_EVENT_TYPE_VSCODE = 'app.editor.activity';

// 通用上下文，所有事件共享。
export interface ICommonEventContext {
    project: string;
    file: string;
    language: string;
    branch: string;
    workspaceId: string;
}

// 项目活动事件数据。
export interface IProjectEventData extends ICommonEventContext {
    editorSessionId: string;
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

// 统一构造项目事件，避免散落拼字段。
export function createProjectEvent(data: IProjectEventData): IEvent {
    return {
        timestamp: new Date(),
        duration: 0,
        data
    };
}

// 统一构造 Agent 事件，避免散落拼字段。
export function createAgentEvent(data: IAgentEventData): IEvent {
    return {
        timestamp: new Date(),
        duration: 0,
        data
    };
}

// 统一构造 Commit 归档事件，方便后续报告脚本直接消费。
export function createCommitArchiveEvent(data: ICommitArchiveEventData): IEvent {
    return {
        timestamp: new Date(),
        // commit 是离散事件，给最小持续时长方便时间线可见。
        duration: 1,
        data
    };
}

// 生成会话 ID，便于上层按会话聚合。
export function createSessionId(prefix: string): string {
    const timePart = Date.now().toString(36);
    const randomPart = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${timePart}_${randomPart}`;
}
