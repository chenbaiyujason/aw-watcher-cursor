import * as assert from 'assert';
import { resolveTimingConfig } from '../config';
import {
    buildContinuousIdentity,
    createContinuousSignalState,
    shouldSendContinuousHeartbeat,
    updateContinuousSignalState
} from '../timeline';

describe('timeline helpers', () => {
    it('buildContinuousIdentity 应将字段串成稳定 merge key', () => {
        const identity = buildContinuousIdentity(['proj', 'file.ts', 'typescript', 'main']);
        assert.ok(identity.indexOf('proj') !== -1);
        assert.ok(identity.indexOf('file.ts') !== -1);
        assert.ok(identity.indexOf('main') !== -1);
    });

    it('shouldSendContinuousHeartbeat 首次 heartbeat 应立即发送', () => {
        const shouldSend = shouldSendContinuousHeartbeat({
            nowMs: 1_000,
            minIntervalMs: 2_000,
            identity: 'proj\u001ffile.ts\u001fmain',
            state: createContinuousSignalState()
        });
        assert.strictEqual(shouldSend, true);
    });

    it('shouldSendContinuousHeartbeat identity 不变且未过 interval 时应跳过', () => {
        const nextState = updateContinuousSignalState(
            createContinuousSignalState(),
            1_000,
            'proj\u001ffile.ts\u001fmain'
        );
        const shouldSend = shouldSendContinuousHeartbeat({
            nowMs: 2_000,
            minIntervalMs: 2_500,
            identity: 'proj\u001ffile.ts\u001fmain',
            state: nextState
        });
        assert.strictEqual(shouldSend, false);
    });

    it('shouldSendContinuousHeartbeat identity 变化时应立即发送（捕获文件切换）', () => {
        const nextState = updateContinuousSignalState(
            createContinuousSignalState(),
            1_000,
            'proj\u001ffile-a.ts\u001fmain'
        );
        const shouldSend = shouldSendContinuousHeartbeat({
            nowMs: 1_500,
            minIntervalMs: 5_000,
            identity: 'proj\u001ffile-b.ts\u001fmain',
            state: nextState
        });
        assert.strictEqual(shouldSend, true);
    });

    it('shouldSendContinuousHeartbeat 过了 interval 后相同 identity 也应发送', () => {
        const nextState = updateContinuousSignalState(
            createContinuousSignalState(),
            1_000,
            'proj\u001ffile.ts\u001fmain'
        );
        const shouldSend = shouldSendContinuousHeartbeat({
            nowMs: 4_000,
            minIntervalMs: 2_000,
            identity: 'proj\u001ffile.ts\u001fmain',
            state: nextState
        });
        assert.strictEqual(shouldSend, true);
    });
});

describe('resolveTimingConfig', () => {
    it('legacy pulseTimeSec 应映射到 fileActivityPulseTimeSec', () => {
        const config = resolveTimingConfig({ pulseTimeSec: 42 });
        assert.strictEqual(config.fileActivityPulseTimeSec, 42);
    });

    it('显式 fileActivityPulseTimeSec 应覆盖 legacy pulseTimeSec', () => {
        const config = resolveTimingConfig({
            pulseTimeSec: 42,
            fileActivityPulseTimeSec: 20
        });
        assert.strictEqual(config.fileActivityPulseTimeSec, 20);
    });

    it('默认配置应满足合理的兜底值', () => {
        const config = resolveTimingConfig({});
        assert.strictEqual(config.maxHeartbeatsPerSec, 0.5);
        assert.strictEqual(config.fileActivityPulseTimeSec, 30);
        assert.strictEqual(config.textChangeDebounceMs, 750);
    });
});
