import * as assert from 'assert';
import {
    createAgentEvent,
    createProjectEvent,
    createSessionId
} from '../events';

describe('events helpers', () => {
    it('createProjectEvent should build AW event structure', () => {
        const event = createProjectEvent({
            project: 'proj',
            file: 'file.ts',
            language: 'typescript',
            branch: 'main',
            workspaceId: 'ws',
            editorSessionId: 'editor_1'
        });
        assert.ok(event.timestamp instanceof Date);
        assert.strictEqual(event.duration, 0);
        assert.strictEqual(event.data.project, 'proj');
    });

    it('createAgentEvent should keep command mapping payload', () => {
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

    it('createSessionId should generate prefixed id', () => {
        const id = createSessionId('agent');
        assert.ok(id.indexOf('agent_') === 0);
        assert.ok(id.length > 10);
    });
});
