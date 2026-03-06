import * as assert from 'assert';
import {
    createAgentEvent,
    createCommitArchiveEvent,
    createFileActivityEvent,
    createSessionId
} from '../events';

describe('events helpers', () => {
    it('createFileActivityEvent 应包含正确的项目与文件字段', () => {
        const event = createFileActivityEvent({
            project: '/Users/me/proj',
            file: '/Users/me/proj/src/a.ts',
            language: 'typescript',
            branch: 'main',
            workspaceId: 'proj',
            activityKind: 'dwell'
        });
        assert.ok(event.timestamp instanceof Date);
        assert.strictEqual(event.duration, 0);
        assert.strictEqual(event.data.project, '/Users/me/proj');
        assert.strictEqual(event.data.file, '/Users/me/proj/src/a.ts');
        assert.strictEqual(event.data.language, 'typescript');
        assert.strictEqual(event.data.branch, 'main');
        assert.strictEqual(event.data.workspaceId, 'proj');
        assert.strictEqual(event.data.activityKind, 'dwell');
    });

    it('createAgentEvent 应保留命令映射字段', () => {
        const event = createAgentEvent({
            project: 'proj',
            file: 'file.ts',
            language: 'typescript',
            branch: 'main',
            workspaceId: 'ws',
            eventName: 'task_start',
            taskKind: 'ask',
            source: 'unknown',
            outcome: 'unknown',
            sessionId: 'agent_1',
            commandId: 'cursor.agent.run',
            mappingVersion: 'v1',
            selectedChars: 10,
            touchedFiles: 1,
            deltaAdded: 0,
            deltaDeleted: 0,
            latencyMs: 0
        });
        assert.ok(event.timestamp instanceof Date);
        assert.strictEqual(event.data.eventName, 'task_start');
        assert.strictEqual(event.data.commandId, 'cursor.agent.run');
    });

    it('createCommitArchiveEvent 默认时长应为 60 秒，在时间线上显眼', () => {
        const event = createCommitArchiveEvent({
            project: 'proj',
            file: 'unknown',
            language: 'unknown',
            branch: 'main',
            workspaceId: 'ws',
            eventName: 'commit_summary',
            commitHashFull: 'abc123',
            parentHashes: ['def456'],
            repoPath: '/tmp/repo',
            authorName: 'redacted',
            authorEmail: 'redacted',
            authorDate: '2026-03-06T00:00:00Z',
            commitDate: '2026-03-06T00:00:00Z',
            subject: 'feat: test',
            body: '',
            relatedAgentSessionId: 'unknown'
        });
        assert.strictEqual(event.duration, 60);
    });

    it('createSessionId 应生成带前缀的唯一 id', () => {
        const id = createSessionId('agent');
        assert.ok(id.indexOf('agent_') === 0);
        assert.ok(id.length > 10);
    });
});
