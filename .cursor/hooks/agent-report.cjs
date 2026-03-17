// @ts-check

/**
 * 只记录用户提交消息前的事件，供后处理阶段自行归类与统计。
 *
 * 字段约定：
 * - `eventName`: `before_submit_prompt`
 * - `conversationId`: 会话级关联键
 * - `workspaceRoots`: 当前工作区根目录列表
 * - `body`: 用户输入完整文本
 */

const os = require('node:os');

/**
 * @typedef {{
 *   hook_event_name?: string;
 *   conversation_id?: string;
 *   workspace_roots?: string[];
 *   prompt?: string;
 * }} HookPayload
 */

/**
 * ActivityWatch 事件负载只保留最小监控字段。
 *
 * @typedef {{
 *   eventName: 'before_submit_prompt';
 *   conversationId: string;
 *   workspaceRoots: string[];
 *   body: string;
 * }} IUserMessageEventData
 */

const ACTIVITYWATCH_BASE_URL = process.env.ACTIVITYWATCH_BASE_URL || 'http://localhost:5600';
const WATCHER_CLIENT_NAME = 'aw-watcher-vscode';
const BUCKET_SUFFIX = 'agent';
const BUCKET_EVENT_TYPE = 'com.activitywatch.cursor.agent.lifecycle';

/**
 * 从 stdin 读取 hook 输入。
 *
 * @returns {Promise<HookPayload>}
 */
async function readPayload() {
    /** @type {Buffer[]} */
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
        return {};
    }
    return /** @type {HookPayload} */ (JSON.parse(raw));
}

/**
 * 生成 ActivityWatch bucket id。
 *
 * @returns {string}
 */
function buildBucketId() {
    return `${WATCHER_CLIENT_NAME}-${BUCKET_SUFFIX}_${os.hostname()}`;
}

/**
 * 文本原样写入事件，后处理阶段再决定是否截断。
 *
 * @param {string} text
 * @returns {string}
 */
function buildBody(text) {
    return text.trim();
}

/**
 * 读取工作区根目录列表，未提供时返回空数组。
 *
 * @param {HookPayload} payload
 * @returns {string[]}
 */
function buildWorkspaceRoots(payload) {
    if (!Array.isArray(payload.workspace_roots)) {
        return [];
    }
    return payload.workspace_roots.filter((item) => typeof item === 'string');
}

/**
 * 基于 hook 输入构造最小事件。
 *
 * @param {HookPayload} payload
 * @returns {IUserMessageEventData | null}
 */
function buildEvent(payload) {
    if (typeof payload.conversation_id !== 'string' || payload.conversation_id.length === 0) {
        return null;
    }
    if (payload.hook_event_name !== 'beforeSubmitPrompt') {
        return null;
    }
    if (typeof payload.prompt !== 'string' || payload.prompt.trim().length === 0) {
        return null;
    }
    return {
        eventName: 'before_submit_prompt',
        conversationId: payload.conversation_id,
        workspaceRoots: buildWorkspaceRoots(payload),
        body: buildBody(payload.prompt)
    };
}

/**
 * 针对不同 hook 返回最安全的响应。
 *
 * @param {string | undefined} hookEventName
 * @returns {string}
 */
function createHookResponse(hookEventName) {
    if (hookEventName === 'beforeSubmitPrompt') {
        return '{"continue":true}\n';
    }
    return '{}\n';
}

/**
 * 将事件写入 ActivityWatch。
 *
 * @param {IUserMessageEventData | null} event
 * @returns {Promise<void>}
 */
async function reportEvent(event) {
    if (!event) {
        return;
    }
    const bucketId = buildBucketId();
    const ensureResponse = await fetch(`${ACTIVITYWATCH_BASE_URL}/api/0/buckets/${encodeURIComponent(bucketId)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            client: WATCHER_CLIENT_NAME,
            type: BUCKET_EVENT_TYPE,
            hostname: os.hostname()
        })
    });
    if (ensureResponse.status !== 200 && ensureResponse.status !== 304) {
        throw new Error(`ensure bucket failed with status ${ensureResponse.status}`);
    }
    const insertResponse = await fetch(`${ACTIVITYWATCH_BASE_URL}/api/0/buckets/${encodeURIComponent(bucketId)}/events`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify([
            {
                timestamp: new Date().toISOString(),
                duration: 0,
                data: event
            }
        ])
    });
    if (insertResponse.status !== 200) {
        throw new Error(`insert event failed with status ${insertResponse.status}`);
    }
}

/**
 * 主流程：
 * - 只响应 `beforeSubmitPrompt`
 * - 上报失败时静默降级，不阻塞 Cursor
 *
 * @returns {Promise<void>}
 */
async function main() {
    const payload = await readPayload();
    const event = buildEvent(payload);
    try {
        await reportEvent(event);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[aw-agent-hook] ${message}\n`);
    }
    process.stdout.write(createHookResponse(payload.hook_event_name));
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[aw-agent-hook-fatal] ${message}\n`);
    process.stdout.write('{}\n');
});
