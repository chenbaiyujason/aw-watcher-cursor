// ActivityWatch 连接状态枚举，供状态栏与错误处理共享。
export type ActivityWatchConnectionState = 'connecting' | 'connected' | 'disconnected';

// 状态栏展示所需的最小快照，避免 UI 层直接拼接控制器内部状态。
export interface IConnectionStatusSnapshot {
    state: ActivityWatchConnectionState;
    lastSuccessfulContactAtMs: number;
    lastErrorMessage: string;
}

// 统一生成状态栏展示文案，便于测试与复用。
export interface IConnectionStatusPresentation {
    text: string;
    tooltip: string;
    accessibilityLabel: string;
}

export function buildConnectionStatusPresentation(
    snapshot: IConnectionStatusSnapshot
): IConnectionStatusPresentation {
    const stateLabel = getStateLabel(snapshot.state);
    const stateIcon = getStateIcon(snapshot.state);
    const lastSuccessText = formatTimestamp(snapshot.lastSuccessfulContactAtMs);
    const lastErrorText = snapshot.lastErrorMessage ? snapshot.lastErrorMessage : '无';
    return {
        text: `${stateIcon} AW ${stateLabel}`,
        tooltip: [
            `ActivityWatch 状态：${stateLabel}`,
            `最近成功通信：${lastSuccessText}`,
            `最近错误：${lastErrorText}`,
            '点击查看详情并可手动重连。'
        ].join('\n'),
        accessibilityLabel: `ActivityWatch ${stateLabel}`
    };
}

// 统一格式化时间，避免 tooltip 出现各平台区域设置差异。
export function formatTimestamp(timestampMs: number): string {
    if (timestampMs <= 0) {
        return '尚未成功连接';
    }
    return new Date(timestampMs).toISOString();
}

function getStateLabel(state: ActivityWatchConnectionState): string {
    if (state === 'connected') {
        return '已连接';
    }
    if (state === 'connecting') {
        return '连接中';
    }
    return '已断开';
}

function getStateIcon(state: ActivityWatchConnectionState): string {
    if (state === 'connected') {
        return '$(pass-filled)';
    }
    if (state === 'connecting') {
        return '$(sync~spin)';
    }
    return '$(warning)';
}
