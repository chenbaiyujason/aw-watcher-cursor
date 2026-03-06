// 原始 timing 配置输入，既支持新字段也兼容旧字段。
export interface IRawTimingConfig {
    maxHeartbeatsPerSec?: number;
    pulseTimeSec?: number;
    fileActivityPulseTimeSec?: number;
    textChangeDebounceMs?: number;
}

// 归一化后的 timing 配置，供扩展内部直接消费。
export interface IResolvedTimingConfig {
    maxHeartbeatsPerSec: number;
    fileActivityPulseTimeSec: number;
    textChangeDebounceMs: number;
}

// 把 legacy `pulseTimeSec` 平滑映射到新的文件活动配置。
export function resolveTimingConfig(rawConfig: IRawTimingConfig): IResolvedTimingConfig {
    const legacyPulseTimeSec = typeof rawConfig.pulseTimeSec === 'number' ? rawConfig.pulseTimeSec : 30;
    return {
        maxHeartbeatsPerSec: typeof rawConfig.maxHeartbeatsPerSec === 'number' ? rawConfig.maxHeartbeatsPerSec : 0.5,
        fileActivityPulseTimeSec: typeof rawConfig.fileActivityPulseTimeSec === 'number'
            ? rawConfig.fileActivityPulseTimeSec
            : legacyPulseTimeSec,
        textChangeDebounceMs: typeof rawConfig.textChangeDebounceMs === 'number' ? rawConfig.textChangeDebounceMs : 750
    };
}
