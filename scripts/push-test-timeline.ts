/**
 * 测试数据推送脚本：向 ActivityWatch 推送一段模拟编码会话。
 *
 * 模型：
 *   - 单条文件活动轨道（fileActivity）：查看与编辑统一，文件切换自然切段。
 *   - 单条 commit 轨道（gitCommit）：60 秒里程碑事件。
 *
 * 场景（从 30 分钟前开始模拟）：
 *   1. 打开 a.ts，阅读 6 分钟，再零星编辑 4 分钟
 *   2. 切换到 b.ts，集中修改 7 分钟
 *   3. 回到 a.ts，继续收尾 5 分钟
 *   4. 切出去跑测试（停止 heartbeat 90 秒）
 *   5. 回到 b.ts，修测试反馈 4 分钟
 *   6. 提交：在末尾插入一个 60 秒 commit 事件
 */

import { resolveTimingConfig } from '../src/config';
import {
    BUCKET_DEFINITIONS,
    WATCHER_CLIENT_NAME,
    FileActivityKind,
    IFileActivityEventData,
    ICommitArchiveEventData
} from '../src/events';
import { hostname } from 'os';

const AW_BASE = 'http://localhost:5600';

interface IRequestInitLike {
    method: string;
    headers: { [key: string]: string };
    body?: string;
}

interface IFetchResponseLike {
    status: number;
    json(): Promise<unknown>;
}

declare function fetch(url: string, init?: IRequestInitLike): Promise<IFetchResponseLike>;

// ------ HTTP 工具 ------

async function requestJson<TBody>(
    method: string,
    url: string,
    body?: TBody
): Promise<{ status: number; data: unknown }> {
    const options: IRequestInitLike = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (body !== undefined) {
        options.body = JSON.stringify(body);
    }
    const res = await fetch(url, options);
    let data: unknown = null;
    try {
        data = await res.json();
    } catch {
        // 不需要解析响应体的操作（如 DELETE）。
    }
    return { status: res.status, data };
}

// ------ Bucket 管理 ------

interface IBucketPayload {
    client: string;
    type: string;
    hostname: string;
}

async function deleteBucketIfExists(bucketId: string): Promise<void> {
    const { status } = await requestJson('DELETE', `${AW_BASE}/api/0/buckets/${bucketId}?force=1`);
    if (status === 200 || status === 404) {
        console.log(`  已清除 ${bucketId} (${status})`);
    } else {
        console.warn(`  清除 ${bucketId} 返回状态 ${status}，继续。`);
    }
}

async function createBucket(bucketId: string, payload: IBucketPayload): Promise<void> {
    const { status } = await requestJson('POST', `${AW_BASE}/api/0/buckets/${bucketId}`, payload);
    if (status !== 200 && status !== 304) {
        throw new Error(`创建 bucket ${bucketId} 失败，状态 ${status}`);
    }
    console.log(`  已创建 ${bucketId}`);
}

// 推送单次 heartbeat，pulsetime 决定相邻事件的最大合并窗口。
async function sendHeartbeat(
    bucketId: string,
    pulseTimeSec: number,
    timestamp: Date,
    durationSec: number,
    data: Record<string, unknown>
): Promise<void> {
    const event = { timestamp: timestamp.toISOString(), duration: durationSec, data };
    const { status } = await requestJson(
        'POST',
        `${AW_BASE}/api/0/buckets/${bucketId}/heartbeat?pulsetime=${pulseTimeSec}`,
        event
    );
    if (status !== 200) {
        throw new Error(`heartbeat 失败，状态 ${status}`);
    }
}

// 插入独立事件（不走 heartbeat 合并）。AW API 接受单个事件或数组。
async function insertEvent(
    bucketId: string,
    timestamp: Date,
    durationSec: number,
    data: Record<string, unknown>
): Promise<void> {
    const event = [{ timestamp: timestamp.toISOString(), duration: durationSec, data }];
    const { status } = await requestJson('POST', `${AW_BASE}/api/0/buckets/${bucketId}/events`, event);
    if (status !== 200) {
        throw new Error(`insertEvent 失败，状态 ${status}`);
    }
}

// ------ 模拟数据推送 ------

const HOST = hostname();
const FILE_ACTIVITY_BUCKET = `test-${WATCHER_CLIENT_NAME}-${BUCKET_DEFINITIONS.fileActivity.suffix}_${HOST}`;
const COMMIT_BUCKET = `test-${WATCHER_CLIENT_NAME}-${BUCKET_DEFINITIONS.gitCommit.suffix}_${HOST}`;

// 与真实扩展一致的 timing 参数，避免产生大量 0 秒碎片事件。
const timingConfig = resolveTimingConfig({});
const PULSE_TIME_SEC = timingConfig.fileActivityPulseTimeSec;
const HEARTBEAT_STEP_MS = Math.round(1000 / timingConfig.maxHeartbeatsPerSec);

function buildFileActivityData(file: 'a' | 'b', activityKind: FileActivityKind): IFileActivityEventData {
    return {
        project: '/test/my-project',
        file: `/test/my-project/src/${file}.ts`,
        language: 'typescript',
        branch: 'main',
        workspaceId: 'my-project',
        activityKind
    };
}

// 推送一段连续文件活动 heartbeat（覆盖 durationMs 毫秒时长）。
async function pushFileActivitySegment(
    bucketId: string,
    startTime: Date,
    durationMs: number,
    file: 'a' | 'b',
    activityKind: FileActivityKind
): Promise<void> {
    const data = buildFileActivityData(file, activityKind) as unknown as Record<string, unknown>;
    let offset = 0;
    while (offset <= durationMs) {
        const ts = new Date(startTime.getTime() + offset);
        await sendHeartbeat(bucketId, PULSE_TIME_SEC, ts, 0, data);
        offset += HEARTBEAT_STEP_MS;
    }
}

async function main() {
    // 检查 ActivityWatch 是否在运行。
    const { status: infoStatus } = await requestJson('GET', `${AW_BASE}/api/0/info`);
    if (infoStatus !== 200) {
        throw new Error('无法连接到 ActivityWatch，请确认 aw-server 已启动。');
    }
    console.log('ActivityWatch 连接成功。\n');

    // 1. 清除旧的测试 bucket。
    console.log('正在清除旧测试 bucket...');
    await deleteBucketIfExists(FILE_ACTIVITY_BUCKET);
    await deleteBucketIfExists(COMMIT_BUCKET);
    console.log();

    // 2. 重建 bucket。
    console.log('正在创建测试 bucket...');
    await createBucket(FILE_ACTIVITY_BUCKET, {
        client: `test-${WATCHER_CLIENT_NAME}`,
        type: BUCKET_DEFINITIONS.fileActivity.eventType,
        hostname: HOST
    });
    await createBucket(COMMIT_BUCKET, {
        client: `test-${WATCHER_CLIENT_NAME}`,
        type: BUCKET_DEFINITIONS.gitCommit.eventType,
        hostname: HOST
    });
    console.log();

    // 3. 推送模拟时间线（从 30 分钟前开始）。
    const now = Date.now();
    const SESSION_START = now - 30 * 60 * 1000;

    console.log('正在推送模拟时间线...');

    // 阶段一：打开 a.ts，先阅读 6 分钟。
    const phase1Start = new Date(SESSION_START);
    const phase1ReadDurationMs = 6 * 60 * 1000;
    console.log(`  [a.ts] 阅读停留 6 分钟...`);
    await pushFileActivitySegment(FILE_ACTIVITY_BUCKET, phase1Start, phase1ReadDurationMs, 'a', 'dwell');

    // 阶段一补充：同文件零星编辑 4 分钟。
    const phase1EditStart = new Date(phase1Start.getTime() + phase1ReadDurationMs + HEARTBEAT_STEP_MS);
    const phase1EditDurationMs = 4 * 60 * 1000;
    console.log(`  [a.ts] 零星编辑 4 分钟...`);
    await pushFileActivitySegment(FILE_ACTIVITY_BUCKET, phase1EditStart, phase1EditDurationMs, 'a', 'edit');

    // 阶段二：切换到 b.ts，集中修改（7 分钟）
    const phase2Start = new Date(phase1EditStart.getTime() + phase1EditDurationMs + HEARTBEAT_STEP_MS);
    const phase2DurationMs = 7 * 60 * 1000;
    console.log(`  [b.ts] 集中修改 7 分钟...`);
    await pushFileActivitySegment(FILE_ACTIVITY_BUCKET, phase2Start, phase2DurationMs, 'b', 'edit');

    // 阶段三：回到 a.ts 收尾（5 分钟）
    const phase3Start = new Date(phase2Start.getTime() + phase2DurationMs + HEARTBEAT_STEP_MS);
    const phase3DurationMs = 5 * 60 * 1000;
    console.log(`  [a.ts] 回到 a.ts 收尾 5 分钟...`);
    await pushFileActivitySegment(FILE_ACTIVITY_BUCKET, phase3Start, phase3DurationMs, 'a', 'edit');

    // 阶段四：切出去测试，停止 heartbeat 90 秒（自然产生时间线空白）。
    const testingGapMs = 90 * 1000;
    console.log(`  [测试] 切出 IDE 运行测试（${testingGapMs / 1000} 秒停顿）...`);

    // 阶段五：回到 b.ts，修测试反馈（4 分钟）
    const phase5Start = new Date(phase3Start.getTime() + phase3DurationMs + testingGapMs);
    const phase5DurationMs = 4 * 60 * 1000;
    console.log(`  [b.ts] 测试完毕回到 b.ts 修反馈 4 分钟...`);
    await pushFileActivitySegment(FILE_ACTIVITY_BUCKET, phase5Start, phase5DurationMs, 'b', 'edit');

    // 阶段六：提交（60 秒里程碑事件，作为时间线上的显著节点）。
    const commitTime = new Date(phase5Start.getTime() + phase5DurationMs + 5000);
    const commitData: ICommitArchiveEventData = {
        project: '/test/my-project',
        file: 'unknown',
        language: 'unknown',
        branch: 'main',
        workspaceId: 'my-project',
        eventName: 'commit_summary',
        commitHashFull: 'deadbeef1234567890abcdef1234567890abcdef',
        parentHashes: ['cafe1234567890abcdef1234567890abcdef1234'],
        repoPath: '/test/my-project',
        authorName: 'redacted',
        authorEmail: 'redacted',
        authorDate: commitTime.toISOString(),
        commitDate: commitTime.toISOString(),
        subject: 'feat: 完成功能并修复 bug',
        body: ''
    };
    await insertEvent(COMMIT_BUCKET, commitTime, 60, commitData as unknown as Record<string, unknown>);
    console.log(`  [commit] 插入 60 秒提交里程碑事件。`);

    console.log('\n✅ 测试数据推送完毕！');
    console.log(`  fileActivity bucket : ${FILE_ACTIVITY_BUCKET}`);
    console.log(`  gitCommit bucket    : ${COMMIT_BUCKET}`);
    console.log(`\n请在 ActivityWatch Web UI 中选择这些 bucket 查看效果。`);
}

main().catch((err: Error) => {
    console.error('推送失败：', err.message);
    process.exit(1);
});
