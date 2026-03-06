import {
    Disposable,
    Extension,
    ExtensionContext,
    TextDocument,
    TextDocumentChangeEvent,
    TextEditor,
    WindowState,
    commands,
    extensions,
    window,
    workspace
} from 'vscode';
import { hostname } from 'os';
import { execFile } from 'child_process';
import { AWClient, IEvent, IEventData } from '../aw-client-js/src/aw-client';
import { API, GitExtension, Repository } from './git';
import {
    BUCKET_DEFINITIONS,
    IAgentEventData,
    ICommonEventContext,
    FileActivityKind,
    IFileActivityEventData,
    createAgentEvent,
    createBucketId,
    createCommitArchiveEvent,
    createFileActivityEvent,
    createSessionId
} from './events';
import {
    IContinuousSignalState,
    buildContinuousIdentity,
    createContinuousSignalState,
    shouldSendContinuousHeartbeat,
    updateContinuousSignalState
} from './timeline';
import { resolveTimingConfig } from './config';

interface IWatcherConfig {
    maxHeartbeatsPerSec: number;
    fileActivityPulseTimeSec: number;
    textChangeDebounceMs: number;
    enableAgentReport: boolean;
    enableCommitArchive: boolean;
    commitBackfillCount: number;
    includeAuthorPII: boolean;
    mappingVersion: string;
    commandMapping: IAgentCommandMapping;
}

interface IAgentCommandMapping {
    panelOpen: string[];
    taskStart: string[];
    taskEnd: string[];
    patchApply: string[];
    patchReject: string[];
}

interface ICommandExecutionEvent {
    command: string;
}

type CommandExecuteHandler = (
    listener: (event: ICommandExecutionEvent) => void,
    thisArgs?: unknown,
    disposables?: Disposable[]
) => Disposable;

interface ICommandExecuteAPI {
    onDidExecuteCommand?: CommandExecuteHandler;
}

type FocusTriggerSource = 'selection' | 'active-editor' | 'save' | 'window-focus' | 'window-blur' | 'ticker' | 'text-change';

// 三类 bucket：文件活动（连续）、agent（离散）、commit（里程碑）。
type BucketKind = 'fileActivity' | 'agentLifecycle' | 'gitCommit';

interface IBucketInfo {
    id: string;
    hostName: string;
    clientName: string;
    eventType: string;
}

interface ICommitDetails {
    commitHashFull: string;
    parentHashes: string[];
    authorName: string;
    authorEmail: string;
    authorDate: string;
    commitDate: string;
    subject: string;
    body: string;
}

const DEFAULT_COMMAND_MAPPING: IAgentCommandMapping = {
    panelOpen: ['cursor.agent.open', 'cursor.chat.open'],
    taskStart: ['cursor.agent.run', 'cursor.chat.send', 'cursor.agent.ask'],
    taskEnd: ['cursor.agent.stop', 'cursor.chat.stop'],
    patchApply: ['cursor.agent.apply', 'cursor.chat.apply'],
    patchReject: ['cursor.agent.reject', 'cursor.chat.reject']
};

export function activate(context: ExtensionContext) {
    console.log('ActivityWatch extension activated.');
    const controller = new ActivityWatchController();
    controller.init();
    context.subscriptions.push(controller);

    // 保留原有刷新命令，重建配置和 bucket 连接。
    const reloadCommand = commands.registerCommand('extension.reload', () => controller.init());
    context.subscriptions.push(reloadCommand);
    // 提供查看当前映射的命令，便于排查 Cursor 命令匹配。
    const showMappingCommand = commands.registerCommand('extension.showAgentCommandMapping', () => controller.showAgentCommandMapping());
    context.subscriptions.push(showMappingCommand);
}

class ActivityWatchController {
    private _disposable: Disposable;
    private _client: AWClient;
    private _git: API | undefined;
    private _config: IWatcherConfig;

    // 三类 bucket 独立创建，连续事件与离散事件互不干扰。
    private _buckets: Record<BucketKind, IBucketInfo>;
    private _bucketCreated: Record<BucketKind, boolean>;

    // 单条文件活动时间线：查看与编辑统一在此 bucket 里连续合并。
    private _fileActivityState: IContinuousSignalState = createContinuousSignalState();

    // 焦点与节流控制。
    private _windowFocused: boolean = true;
    private _lastTextChangeSignalAtMs: number = 0;
    private _lastEditingActivityAtMs: number = 0;
    private _tickerHandle: ReturnType<typeof setInterval> | undefined;
    private _tickerIntervalMs: number = 1000;
    private _fileEditingIdleMs: number = 5000;

    // Agent 状态缓存，用于串联 session 与任务耗时。
    private _agentSessionId: string = createSessionId('agent');
    private _agentTaskStartTimeMs: number = 0;
    private _lastAgentEventAtMs: number = 0;

    // Commit 归档状态缓存，用于去重和变更检测。
    private _repoSubscriptions: Disposable[] = [];
    private _repoHeadCache: { [repoPath: string]: string } = {};
    private _archivedCommitHashes: { [commitHash: string]: boolean } = {};

    constructor() {
        const clientName = 'aw-watcher-vscode';
        const hostName = hostname();
        this._buckets = {
            fileActivity: this._createBucketInfo(clientName, hostName, 'fileActivity'),
            agentLifecycle: this._createBucketInfo(clientName, hostName, 'agentLifecycle'),
            gitCommit: this._createBucketInfo(clientName, hostName, 'gitCommit')
        };
        this._bucketCreated = {
            fileActivity: false,
            agentLifecycle: false,
            gitCommit: false
        };
        this._client = new AWClient(clientName, { testing: false });
        this._config = this._loadConfigurations();

        const subscriptions: Disposable[] = [];
        window.onDidChangeTextEditorSelection(() => this._onFocusSignal('selection'), this, subscriptions);
        window.onDidChangeActiveTextEditor((editor) => this._onActiveEditorChanged(editor), this, subscriptions);
        window.onDidChangeWindowState((state) => this._onWindowStateChanged(state), this, subscriptions);
        workspace.onDidChangeTextDocument((event) => this._onTextDocumentChanged(event), this, subscriptions);
        workspace.onDidSaveTextDocument((document) => this._onDocumentSaved(document), this, subscriptions);
        this._registerAgentCommandWatcher(subscriptions);
        this._disposable = Disposable.from(...subscriptions);
    }

    public init() {
        this._config = this._loadConfigurations();
        this._ensureAllBuckets();
        this._startTicker();
        this._initGit()
            .then((res) => {
                this._git = res;
                this._registerCommitWatchers();
                this._runCommitBackfill();
            })
            .catch((err: Error) => {
                this._handleError(`Git API init failed: ${err.message}`);
            });
    }

    public dispose() {
        this._stopTicker();
        this._disposeRepoSubscriptions();
        this._disposable.dispose();
    }

    public showAgentCommandMapping() {
        const mappingText = JSON.stringify(this._config.commandMapping, undefined, 2);
        window.showInformationMessage(`ActivityWatch agent mapping: ${mappingText}`);
    }

    // 根据统一常量创建 bucket 描述，确保 watcher 与报表使用同一命名规则。
    private _createBucketInfo(clientName: string, hostName: string, kind: BucketKind): IBucketInfo {
        const definition = BUCKET_DEFINITIONS[kind];
        return {
            id: createBucketId(definition.suffix, hostName),
            hostName,
            clientName,
            eventType: definition.eventType
        };
    }

    private _ensureBucket(bucket: IBucketInfo, onUpdated: (created: boolean) => void) {
        this._client.ensureBucket(bucket.id, bucket.eventType, bucket.hostName)
            .then(() => onUpdated(true))
            .catch((err: Error) => {
                this._handleError(`Couldn't create bucket ${bucket.eventType}.`, true);
                onUpdated(false);
                console.error(err);
            });
    }

    // 三类 bucket 各自创建，单个失败不影响其他轨道。
    private _ensureAllBuckets() {
        const bucketKinds: BucketKind[] = ['fileActivity', 'agentLifecycle', 'gitCommit'];
        bucketKinds.forEach((bucketKind) => {
            this._bucketCreated[bucketKind] = false;
            this._ensureBucket(this._buckets[bucketKind], (created) => {
                this._bucketCreated[bucketKind] = created;
            });
        });
    }

    private async _initGit(): Promise<API> {
        const extension = extensions.getExtension('vscode.git') as Extension<GitExtension> | undefined;
        if (!extension) {
            throw new Error('vscode.git extension was not found.');
        }
        const gitExtension = extension.isActive ? extension.exports : await extension.activate();
        return gitExtension.getAPI(1);
    }

    private _loadConfigurations(): IWatcherConfig {
        const extConfigurations = workspace.getConfiguration('aw-watcher-vscode');
        const timingConfig = resolveTimingConfig({
            maxHeartbeatsPerSec: extConfigurations.get<number>('maxHeartbeatsPerSec'),
            pulseTimeSec: extConfigurations.get<number>('pulseTimeSec'),
            fileActivityPulseTimeSec: extConfigurations.get<number>('fileActivityPulseTimeSec'),
            textChangeDebounceMs: extConfigurations.get<number>('textChangeDebounceMs')
        });
        const enableAgentReport = extConfigurations.get<boolean>('enableAgentReport', true);
        const enableCommitArchive = extConfigurations.get<boolean>('enableCommitArchive', true);
        const commitBackfillCount = extConfigurations.get<number>('commitBackfillCount', 20);
        const includeAuthorPII = extConfigurations.get<boolean>('includeAuthorPII', false);
        const mappingVersion = extConfigurations.get<string>('mappingVersion', 'v1');
        const commandMapping = this._readCommandMapping(extConfigurations.get<unknown>('agentCommandMapping'));
        return {
            maxHeartbeatsPerSec: timingConfig.maxHeartbeatsPerSec,
            fileActivityPulseTimeSec: timingConfig.fileActivityPulseTimeSec,
            textChangeDebounceMs: timingConfig.textChangeDebounceMs,
            enableAgentReport,
            enableCommitArchive,
            commitBackfillCount,
            includeAuthorPII,
            mappingVersion,
            commandMapping
        };
    }

    private _readCommandMapping(rawValue: unknown): IAgentCommandMapping {
        if (!rawValue || typeof rawValue !== 'object') {
            return DEFAULT_COMMAND_MAPPING;
        }
        const candidate = rawValue as { [key: string]: unknown };
        const readList = (key: keyof IAgentCommandMapping): string[] => {
            const value = candidate[key];
            if (!Array.isArray(value)) {
                return DEFAULT_COMMAND_MAPPING[key];
            }
            const normalized = value.filter((item) => typeof item === 'string').map((item) => item as string);
            return normalized.length ? normalized : DEFAULT_COMMAND_MAPPING[key];
        };
        return {
            panelOpen: readList('panelOpen'),
            taskStart: readList('taskStart'),
            taskEnd: readList('taskEnd'),
            patchApply: readList('patchApply'),
            patchReject: readList('patchReject')
        };
    }

    // 注册命令执行监听，识别 Cursor Agent 事件。
    private _registerAgentCommandWatcher(subscriptions: Disposable[]) {
        const commandApi = commands as ICommandExecuteAPI;
        if (!commandApi.onDidExecuteCommand) {
            console.warn('[ActivityWatch] onDidExecuteCommand not available in current VS Code API.');
            return;
        }
        commandApi.onDidExecuteCommand((event: ICommandExecutionEvent) => this._onCommandExecuted(event.command), this, subscriptions);
    }

    // 定时器保证"只是停留思考"也能持续刷新 heartbeat，让停留时段自然延展。
    private _startTicker() {
        this._stopTicker();
        this._tickerHandle = setInterval(() => this._onTicker(), this._tickerIntervalMs);
    }

    private _stopTicker() {
        if (this._tickerHandle) {
            clearInterval(this._tickerHandle);
            this._tickerHandle = undefined;
        }
    }

    private _onTicker() {
        this._emitContinuousSignals(Date.now(), 'ticker');
    }

    // 活动编辑器切换时立刻刷新，保证文件切换段落即时被记录。
    private _onActiveEditorChanged(_editor: TextEditor | undefined) {
        this._emitContinuousSignals(Date.now(), 'active-editor');
    }

    // selection 变化表示用户还在看文件，作为停留信号的辅助来源。
    private _onFocusSignal(_trigger: FocusTriggerSource) {
        this._emitContinuousSignals(Date.now(), 'selection');
    }

    // 文本变更走 debounce 控制刷新频率，避免极速打字产生无数碎片事件。
    private _onTextDocumentChanged(event: TextDocumentChangeEvent) {
        if (!this._isActiveFileDocument(event.document) || event.contentChanges.length === 0) {
            return;
        }
        const now = Date.now();
        this._lastEditingActivityAtMs = now;
        if (now - this._lastTextChangeSignalAtMs < this._config.textChangeDebounceMs) {
            return;
        }
        this._lastTextChangeSignalAtMs = now;
        this._emitContinuousSignals(now, 'text-change');
    }

    // 保存是编辑阶段的自然稳定点，触发一次 heartbeat 让 pulsetime 计算更准确。
    private _onDocumentSaved(document: TextDocument) {
        if (!this._isActiveFileDocument(document)) {
            return;
        }
        const now = Date.now();
        this._lastEditingActivityAtMs = now;
        this._emitContinuousSignals(now, 'save');
    }

    // 窗口失焦前先打一次最后心跳，尽量把停留段落延展到切出时刻。
    private _onWindowStateChanged(state: WindowState) {
        if (!state.focused) {
            this._emitContinuousSignals(Date.now(), 'window-blur');
        }
        this._windowFocused = state.focused;
        if (state.focused) {
            this._emitContinuousSignals(Date.now(), 'window-focus');
        }
    }

    // 单条连续文件活动时间线：查看与编辑统一上报，无需区分模式。
    private _emitContinuousSignals(nowMs: number, reason: FocusTriggerSource) {
        if (!this._windowFocused || !this._shouldTrackEditorEvent()) {
            return;
        }
        this._trackFileActivity(nowMs, reason);
    }

    // 文件活动 heartbeat：文件切换或活动类型变化时，identity 变化会自动在 AW 里形成新段落。
    private _trackFileActivity(nowMs: number, reason: FocusTriggerSource) {
        if (!this._bucketCreated.fileActivity) {
            return;
        }
        const contextData = this._getCommonContext();
        const activityKind = this._resolveFileActivityKind(nowMs, reason);
        const identity = buildContinuousIdentity([
            contextData.project,
            contextData.file,
            contextData.language,
            contextData.branch,
            contextData.workspaceId,
            activityKind
        ]);
        const shouldSend = shouldSendContinuousHeartbeat({
            nowMs,
            minIntervalMs: this._getMinHeartbeatIntervalMs(),
            identity,
            state: this._fileActivityState
        });
        if (!shouldSend) {
            return;
        }
        const eventData: IFileActivityEventData = {
            project: contextData.project,
            file: contextData.file,
            language: contextData.language,
            branch: contextData.branch,
            workspaceId: contextData.workspaceId,
            activityKind
        };
        const event = createFileActivityEvent(eventData);
        this._fileActivityState = updateContinuousSignalState(this._fileActivityState, nowMs, identity);
        this._sendHeartbeat('fileActivity', this._config.fileActivityPulseTimeSec, event);
    }

    // 通过“直接编辑触发 + 短暂编辑余温”推断当前文件活动类型，避免刚打字完就立刻退化成纯停留。
    private _resolveFileActivityKind(nowMs: number, reason: FocusTriggerSource): FileActivityKind {
        if (reason === 'text-change' || reason === 'save') {
            return 'edit';
        }
        return nowMs - this._lastEditingActivityAtMs <= this._fileEditingIdleMs ? 'edit' : 'dwell';
    }

    private _getMinHeartbeatIntervalMs(): number {
        const safeRate = this._config.maxHeartbeatsPerSec > 0 ? this._config.maxHeartbeatsPerSec : 0.5;
        return Math.max(250, Math.floor(1000 / safeRate));
    }

    private _onCommandExecuted(commandId: string) {
        if (!this._config.enableAgentReport || !this._bucketCreated.agentLifecycle) {
            return;
        }
        const eventName = this._mapCommandToAgentEvent(commandId);
        if (!eventName) {
            return;
        }
        const nowMs = Date.now();
        this._lastAgentEventAtMs = nowMs;
        if (eventName === 'panel_open') {
            this._agentSessionId = createSessionId('agent');
        }
        if (eventName === 'task_start') {
            this._agentTaskStartTimeMs = nowMs;
        }
        const latencyMs = this._agentTaskStartTimeMs > 0 ? nowMs - this._agentTaskStartTimeMs : 0;
        const contextData = this._getCommonContext();
        const eventData: IAgentEventData = {
            project: contextData.project,
            file: contextData.file,
            language: contextData.language,
            branch: contextData.branch,
            workspaceId: contextData.workspaceId,
            eventName,
            taskKind: this._inferTaskKind(commandId),
            source: this._inferCommandSource(commandId),
            outcome: this._mapOutcome(eventName),
            sessionId: this._agentSessionId,
            commandId,
            mappingVersion: this._config.mappingVersion,
            selectedChars: this._getSelectionCharCount(),
            touchedFiles: this._getTouchedFilesCount(),
            deltaAdded: 0,
            deltaDeleted: 0,
            latencyMs
        };
        const event = createAgentEvent(eventData);
        this._sendEvent('agentLifecycle', event);
    }

    private _mapCommandToAgentEvent(commandId: string): IAgentEventData['eventName'] | undefined {
        if (this._matchCommand(commandId, this._config.commandMapping.panelOpen)) {
            return 'panel_open';
        }
        if (this._matchCommand(commandId, this._config.commandMapping.taskStart)) {
            return 'task_start';
        }
        if (this._matchCommand(commandId, this._config.commandMapping.taskEnd)) {
            return 'task_end';
        }
        if (this._matchCommand(commandId, this._config.commandMapping.patchApply)) {
            return 'patch_apply';
        }
        if (this._matchCommand(commandId, this._config.commandMapping.patchReject)) {
            return 'patch_reject';
        }
        if (this._isCursorAgentCommand(commandId)) {
            return 'agent_command';
        }
        return undefined;
    }

    // 支持"等值 + 前缀通配 + 包含"三种匹配，兼容命令 ID 变体。
    private _matchCommand(commandId: string, patterns: string[]): boolean {
        return patterns.some((pattern) => {
            if (commandId === pattern) {
                return true;
            }
            if (pattern.endsWith('.*')) {
                const prefix = pattern.slice(0, pattern.length - 1);
                return commandId.startsWith(prefix);
            }
            return commandId.indexOf(pattern) !== -1;
        });
    }

    private _inferTaskKind(commandId: string): IAgentEventData['taskKind'] {
        const lowerCommand = commandId.toLowerCase();
        if (lowerCommand.indexOf('explain') !== -1) {
            return 'explain';
        }
        if (lowerCommand.indexOf('fix') !== -1) {
            return 'fix';
        }
        if (lowerCommand.indexOf('refactor') !== -1) {
            return 'refactor';
        }
        if (lowerCommand.indexOf('test') !== -1) {
            return 'test_gen';
        }
        if (lowerCommand.indexOf('ask') !== -1 || lowerCommand.indexOf('chat') !== -1) {
            return 'ask';
        }
        return 'unknown';
    }

    private _inferCommandSource(commandId: string): IAgentEventData['source'] {
        const lowerCommand = commandId.toLowerCase();
        if (lowerCommand.indexOf('palette') !== -1) {
            return 'command_palette';
        }
        if (lowerCommand.indexOf('context') !== -1) {
            return 'context_menu';
        }
        if (lowerCommand.indexOf('key') !== -1 || lowerCommand.indexOf('shortcut') !== -1) {
            return 'shortcut';
        }
        return 'unknown';
    }

    private _mapOutcome(eventName: IAgentEventData['eventName']): IAgentEventData['outcome'] {
        if (eventName === 'patch_apply') {
            return 'accepted';
        }
        if (eventName === 'patch_reject') {
            return 'rejected';
        }
        if (eventName === 'task_end') {
            return 'success';
        }
        return 'unknown';
    }

    // 对 Cursor 命令做兜底捕获，避免映射遗漏导致漏记。
    private _isCursorAgentCommand(commandId: string): boolean {
        const lowerCommand = commandId.toLowerCase();
        return lowerCommand.indexOf('cursor') !== -1 || lowerCommand.indexOf('anysphere') !== -1;
    }

    private _sendHeartbeat<TData extends IEventData>(bucketKind: BucketKind, pulseTimeSec: number, event: IEvent<TData>) {
        const bucket = this._buckets[bucketKind];
        return this._client.heartbeat(bucket.id, pulseTimeSec, event)
            .catch((err: Error) => {
                console.error('sendHeartbeat error:', err);
                this._handleError('Error while sending heartbeat', true);
            });
    }

    // 非连续型事件（agent / commit）使用 insertEvent，保留独立段落不被合并。
    private _sendEvent<TData extends IEventData>(bucketKind: BucketKind, event: IEvent<TData>) {
        const bucket = this._buckets[bucketKind];
        return this._client.insertEvent(bucket.id, event)
            .catch((err: Error) => {
                console.error('sendEvent error:', err);
                this._handleError('Error while sending event', true);
            });
    }

    // 注册仓库状态监听，用于捕获 HEAD 变化并归档 commit。
    private _registerCommitWatchers() {
        this._disposeRepoSubscriptions();
        if (!this._config.enableCommitArchive || !this._git) {
            return;
        }
        this._git.repositories.forEach((repository) => this._watchRepositoryState(repository));
        const openDisposable = this._git.onDidOpenRepository((repository) => this._watchRepositoryState(repository));
        this._repoSubscriptions.push(openDisposable);
        const closeDisposable = this._git.onDidCloseRepository((repository) => {
            const repoPath = repository.rootUri.fsPath;
            delete this._repoHeadCache[repoPath];
        });
        this._repoSubscriptions.push(closeDisposable);
    }

    private _watchRepositoryState(repository: Repository) {
        const repoPath = repository.rootUri.fsPath;
        const headCommit = repository.state.HEAD && repository.state.HEAD.commit ? repository.state.HEAD.commit : '';
        this._repoHeadCache[repoPath] = headCommit;
        const stateDisposable = repository.state.onDidChange(() => {
            this._onRepositoryStateChanged(repository);
        });
        this._repoSubscriptions.push(stateDisposable);
    }

    private _onRepositoryStateChanged(repository: Repository) {
        if (!this._config.enableCommitArchive || !this._bucketCreated.gitCommit) {
            return;
        }
        const repoPath = repository.rootUri.fsPath;
        const currentHead = repository.state.HEAD && repository.state.HEAD.commit ? repository.state.HEAD.commit : '';
        if (!currentHead) {
            return;
        }
        const previousHead = this._repoHeadCache[repoPath];
        if (currentHead === previousHead) {
            return;
        }
        this._repoHeadCache[repoPath] = currentHead;
        this._archiveCommit(repository, currentHead);
    }

    // 启动时回补最近提交，避免扩展未运行期间的漏采。
    private _runCommitBackfill() {
        if (!this._config.enableCommitArchive || !this._bucketCreated.gitCommit || !this._git) {
            return;
        }
        this._git.repositories.forEach((repository) => {
            this._archiveRecentCommits(repository);
        });
    }

    private async _archiveRecentCommits(repository: Repository): Promise<void> {
        try {
            const repoPath = repository.rootUri.fsPath;
            const commandResult = await this._runGitCommand(
                repoPath,
                ['log', `-${this._config.commitBackfillCount}`, '--pretty=format:%H']
            );
            const commitHashes = commandResult
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                .reverse();
            for (let index = 0; index < commitHashes.length; index += 1) {
                await this._archiveCommit(repository, commitHashes[index]);
            }
        } catch (err) {
            const error = err as Error;
            this._handleError(`Commit backfill failed: ${error.message}`);
        }
    }

    private async _archiveCommit(repository: Repository, commitHash: string): Promise<void> {
        if (this._archivedCommitHashes[commitHash]) {
            return;
        }
        try {
            const details = await this._readCommitDetails(repository, commitHash);
            this._archivedCommitHashes[commitHash] = true;
            const context = this._buildCommitContext(repository);
            const relatedAgentSessionId = this._getRelatedAgentSessionId();
            const summaryEvent = createCommitArchiveEvent({
                eventName: 'commit_summary',
                commitHashFull: details.commitHashFull,
                parentHashes: details.parentHashes,
                repoPath: repository.rootUri.fsPath,
                project: context.project,
                file: context.file,
                language: context.language,
                branch: context.branch,
                workspaceId: context.workspaceId,
                authorName: details.authorName,
                authorEmail: details.authorEmail,
                authorDate: details.authorDate,
                commitDate: details.commitDate,
                subject: details.subject,
                body: details.body,
                relatedAgentSessionId
            });
            await this._sendEvent('gitCommit', summaryEvent);
        } catch (err) {
            const error = err as Error;
            this._handleError(`Commit archive failed for ${commitHash}: ${error.message}`);
        }
    }

    private _buildCommitContext(repository: Repository): ICommonEventContext {
        const repoPath = repository.rootUri.fsPath;
        const branch = repository.state.HEAD && repository.state.HEAD.name ? repository.state.HEAD.name : 'unknown';
        return {
            project: repoPath || 'unknown',
            file: 'unknown',
            language: 'unknown',
            branch,
            workspaceId: this._getWorkspaceId()
        };
    }

    private async _readCommitDetails(repository: Repository, commitHash: string): Promise<ICommitDetails> {
        const repoPath = repository.rootUri.fsPath;
        const summaryRaw = await this._runGitCommand(
            repoPath,
            ['show', '-s', '--no-color', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s%x1f%b', commitHash]
        );
        const summaryParts = summaryRaw.split('\u001f');
        if (summaryParts.length < 8) {
            throw new Error('Unexpected git summary output.');
        }
        const includeAuthorPII = this._config.includeAuthorPII;
        const parentHashes = summaryParts[1]
            .split(' ')
            .map((hash) => hash.trim())
            .filter((hash) => hash.length > 0);
        return {
            commitHashFull: summaryParts[0].trim(),
            parentHashes,
            authorName: includeAuthorPII ? summaryParts[2].trim() : 'redacted',
            authorEmail: includeAuthorPII ? summaryParts[3].trim() : 'redacted',
            authorDate: summaryParts[4].trim(),
            commitDate: summaryParts[5].trim(),
            subject: summaryParts[6].trim(),
            body: summaryParts.slice(7).join('\u001f').trim()
        };
    }

    private async _runGitCommand(repoPath: string, args: string[]): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            execFile(
                'git',
                args,
                { cwd: repoPath, maxBuffer: 1024 * 1024 * 30 },
                (error, stdout) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve(stdout.toString());
                }
            );
        });
    }

    private _getRelatedAgentSessionId(): string {
        const nowMs = Date.now();
        const tenMinutesMs = 10 * 60 * 1000;
        return nowMs - this._lastAgentEventAtMs <= tenMinutesMs ? this._agentSessionId : 'unknown';
    }

    private _disposeRepoSubscriptions() {
        this._repoSubscriptions.forEach((disposable) => disposable.dispose());
        this._repoSubscriptions = [];
    }

    private _getCommonContext(): ICommonEventContext {
        return {
            project: this._getProjectFolder(),
            file: this._getFilePath(),
            language: this._getFileLanguage(),
            branch: this._getCurrentBranch(),
            workspaceId: this._getWorkspaceId()
        };
    }

    private _getProjectFolder(): string {
        const editor = window.activeTextEditor;
        if (editor) {
            const workspaceFolder = workspace.getWorkspaceFolder(editor.document.uri);
            if (workspaceFolder) {
                return workspaceFolder.uri.fsPath;
            }
        }
        const repository = this._getActiveRepository();
        if (repository) {
            return repository.rootUri.fsPath;
        }
        return 'unknown';
    }

    private _getWorkspaceId(): string {
        const editor = window.activeTextEditor;
        if (editor) {
            const workspaceFolder = workspace.getWorkspaceFolder(editor.document.uri);
            if (workspaceFolder) {
                return workspaceFolder.name;
            }
        }
        const repository = this._getActiveRepository();
        if (repository) {
            const pathParts = repository.rootUri.fsPath.split(/[\\/]/).filter((part) => part.length > 0);
            return pathParts.length > 0 ? pathParts[pathParts.length - 1] : repository.rootUri.fsPath;
        }
        return 'unknown';
    }

    private _getFilePath(): string {
        const editor = window.activeTextEditor;
        return editor ? editor.document.fileName : 'unknown';
    }

    private _getFileLanguage(): string {
        const editor = window.activeTextEditor;
        return editor ? editor.document.languageId : 'unknown';
    }

    private _getCurrentBranch(): string {
        if (!this._git) {
            return 'unknown';
        }
        const repository = this._getActiveRepository();
        return repository && repository.state.HEAD && repository.state.HEAD.name ? repository.state.HEAD.name : 'unknown';
    }

    private _getActiveRepository(): Repository | undefined {
        if (!this._git) {
            return undefined;
        }
        const editor = window.activeTextEditor;
        if (editor) {
            const found = this._git.getRepository(editor.document.uri);
            if (found) {
                return found;
            }
        }
        return this._git.repositories[0];
    }

    private _getSelectionCharCount(): number {
        const editor = window.activeTextEditor;
        if (!editor || editor.selections.length === 0) {
            return 0;
        }
        let total = 0;
        editor.selections.forEach((selection) => {
            total += Math.abs(selection.end.character - selection.start.character);
        });
        return total;
    }

    private _getTouchedFilesCount(): number {
        if (!this._git) {
            return 0;
        }
        const repository = this._getActiveRepository();
        if (!repository) {
            return 0;
        }
        return repository.state.workingTreeChanges.length + repository.state.indexChanges.length;
    }

    private _isActiveFileDocument(document: TextDocument): boolean {
        const editor = window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
            return false;
        }
        return editor.document.uri.toString() === document.uri.toString();
    }

    // 仅统计真实文件编辑器，避免 tasks/log/review 面板造成噪音。
    private _shouldTrackEditorEvent(): boolean {
        const editor = window.activeTextEditor;
        if (!editor) {
            return false;
        }
        return editor.document.uri.scheme === 'file';
    }

    private _handleError(err: string, isCritical: boolean = false): undefined {
        if (isCritical) {
            console.error('[ActivityWatch][handleError]', err);
            window.showErrorMessage(`[ActivityWatch] ${err}`);
        } else {
            console.warn('[ActivityWatch][handleError]', err);
        }
        return undefined;
    }
}
