// 连续 heartbeat 的状态缓存，帮助不同信号独立节流。
export interface IContinuousSignalState {
    lastHeartbeatAtMs: number;
    lastIdentity: string;
}

// 聚合连续信号判断参数，避免在控制器里散落布尔逻辑。
export interface IContinuousSignalDecisionInput {
    nowMs: number;
    minIntervalMs: number;
    identity: string;
    state: IContinuousSignalState;
}

// 初始化连续信号状态，默认表示还未上报过 heartbeat。
export function createContinuousSignalState(): IContinuousSignalState {
    return {
        lastHeartbeatAtMs: 0,
        lastIdentity: ''
    };
}

// 使用稳定字符串表示 heartbeat 的 merge key，方便比较是否切段。
export function buildContinuousIdentity(parts: string[]): string {
    return parts.join('\u001f');
}

// 判断当前是否应该发送新的连续 heartbeat。
export function shouldSendContinuousHeartbeat(input: IContinuousSignalDecisionInput): boolean {
    if (input.identity !== input.state.lastIdentity) {
        return true;
    }
    return input.state.lastHeartbeatAtMs + input.minIntervalMs <= input.nowMs;
}

// 在成功发送 heartbeat 后更新缓存状态。
export function updateContinuousSignalState(
    state: IContinuousSignalState,
    nowMs: number,
    identity: string
): IContinuousSignalState {
    return {
        lastHeartbeatAtMs: nowMs,
        lastIdentity: identity
    };
}
