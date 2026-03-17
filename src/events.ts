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
}

// bucket 定义帮助扩展与报表共用统一常量。
export interface IBucketDefinition {
    suffix: string;
    eventType: string;
}

// 三类 bucket：文件活动（连续）、agent（离散）、commit（离散里程碑）。
export const BUCKET_DEFINITIONS: {
    fileActivity: IBucketDefinition;
    gitCommit: IBucketDefinition;
} = {
    fileActivity: {
        suffix: BUCKET_SUFFIX_FILE_ACTIVITY,
        eventType: BUCKET_EVENT_TYPE_FILE_ACTIVITY
    },
    gitCommit: {
        suffix: BUCKET_SUFFIX_COMMIT,
        eventType: BUCKET_EVENT_TYPE_GIT_COMMIT
    }
};

// 统一构造文件活动事件，查看和编辑共用同一 builder。
export function createFileActivityEvent(data: IFileActivityEventData): IEvent {
    return {
        timestamp: new Date(),
        duration: 0,
        data
    };
}

// Commit 作为里程碑事件，默认 60 秒让时间线上更显眼。
export function createCommitArchiveEvent(data: ICommitArchiveEventData): IEvent {
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
