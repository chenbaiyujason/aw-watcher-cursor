import * as assert from 'assert';
import {
    buildConnectionStatusPresentation,
    formatTimestamp
} from '../connection-status';
import {
    createCommitArchiveEvent,
    createFileActivityEvent
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
            body: ''
        });
        assert.strictEqual(event.duration, 60);
    });
});

describe('connection status helpers', () => {
    it('buildConnectionStatusPresentation 应返回已连接文案', () => {
        const presentation = buildConnectionStatusPresentation({
            state: 'connected',
            lastSuccessfulContactAtMs: Date.parse('2026-03-17T12:00:00.000Z'),
            lastErrorMessage: ''
        });
        assert.strictEqual(presentation.text, '$(pass-filled) AW 已连接');
        assert.ok(presentation.tooltip.indexOf('最近成功通信：2026-03-17T12:00:00.000Z') !== -1);
    });

    it('buildConnectionStatusPresentation 应返回断开时的错误摘要', () => {
        const presentation = buildConnectionStatusPresentation({
            state: 'disconnected',
            lastSuccessfulContactAtMs: 0,
            lastErrorMessage: 'connect ECONNREFUSED'
        });
        assert.strictEqual(presentation.text, '$(warning) AW 已断开');
        assert.ok(presentation.tooltip.indexOf('最近错误：connect ECONNREFUSED') !== -1);
    });

    it('formatTimestamp 在无成功连接记录时应给出默认文案', () => {
        assert.strictEqual(formatTimestamp(0), '尚未成功连接');
    });
});
