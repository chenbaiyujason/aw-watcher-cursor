import {
    Disposable,
    Extension,
    ExtensionContext,
    StatusBarAlignment,
    StatusBarItem,
    TextDocument,
    TextDocumentChangeEvent,
    TextEditor,
    ThemeColor,
    WindowState,
    commands,
    extensions,
    window,
    workspace
} from 'vscode';
import { hostname } from 'os';
import { execFile } from 'child_process';
import { AWClient, IEvent } from '../aw-client-js/src/aw-client';
import { API, GitExtension, Repository } from './git';
import { installBundledCursorHooks } from './cursor-hooks';
import {
    BUCKET_DEFINITIONS,
    ICommonEventContext,
    FileActivityKind,
    IFileActivityEventData,
    createBucketId,
    createCommitArchiveEvent,
    createFileActivityEvent
} from './events';
import {
    IContinuousSignalState,
    buildContinuousIdentity,
    createContinuousSignalState,
    shouldSendContinuousHeartbeat,
    updateContinuousSignalState
} from './timeline';
import { resolveTimingConfig } from './config';
import {
    ActivityWatchConnectionState,
    buildConnectionStatusPresentation,
    formatTimestamp
} from './connection-status';

interface IWatcherConfig {
    maxHeartbeatsPerSec: number;
    fileActivityPulseTimeSec: number;
    textChangeDebounceMs: number;
    enableCommitArchive: boolean;
    commitBackfillCount: number;
    includeAuthorPII: boolean;
}

type FocusTriggerSource = 'selection' | 'active-editor' | 'save' | 'window-focus' | 'window-blur' | 'ticker' | 'text-change';

// 两类 bucket：文件活动（连续）与 commit（里程碑）。
type BucketKind = 'fileActivity' | 'gitCommit';

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
export function activate(context: ExtensionContext) {
    console.log('ActivityWatch extension activated.');
    // 扩展激活后立即尝试同步全局 Cursor Hooks，确保新增 hook 能自动生效。
    void installBundledCursorHooks(context);
    const controller = new ActivityWatchController();
    // 先注册命令，再启动初始化，避免初始化阶段异常时命令不可用。
    const reloadCommand = commands.registerCommand('extension.reload', () => controller.init());
    const showStatusCommand = commands.registerCommand('aw-watcher-vscode.showConnectionStatus', () => controller.showConnectionStatus());
    const reconnectCommand = commands.registerCommand('aw-watcher-vscode.reconnect', () => controller.reconnect());
    context.subscriptions.push(controller, reloadCommand, showStatusCommand, reconnectCommand);
    controller.init();
}

class ActivityWatchController {
    private _disposable: Disposable;
    private _client: AWClient;
    private _git: API | undefined;
    private _config: IWatcherConfig;

    // 两类 bucket 独立创建，连续事件与离散事件互不干扰。
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
    // 连接状态由状态栏展示，方便直接判断当前是否还能向 AW 推送。
    private _statusBarItem: StatusBarItem;
    private _connectionState: ActivityWatchConnectionState = 'connecting';
    private _lastSuccessfulContactAtMs: number = 0;
    private _lastConnectionErrorMessage: string = '';
    private _connectionHealthHandle: ReturnType<typeof setInterval> | undefined;
    private _connectionHealthIntervalMs: number = 15000;
    private _connectionCheckInFlight: boolean = false;

    // Commit 归档状态缓存，用于去重和变更检测。
    private _repoSubscriptions: Disposable[] = [];
    private _repoHeadCache: { [repoPath: string]: string } = {};
    private _archivedCommitHashes: { [commitHash: string]: boolean } = {};

    constructor() {
        const clientName = 'aw-watcher-vscode';
        const hostName = hostname();
        this._buckets = {
            fileActivity: this._createBucketInfo(clientName, hostName, 'fileActivity'),
            gitCommit: this._createBucketInfo(clientName, hostName, 'gitCommit')
        };
        this._bucketCreated = {
            fileActivity: false,
            gitCommit: false
        };
        this._client = new AWClient(clientName, { testing: false });
        this._config = this._loadConfigurations();
        this._statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 100);
        this._statusBarItem.command = 'aw-watcher-vscode.showConnectionStatus';
        this._statusBarItem.show();
        this._refreshStatusBar();

        const subscriptions: Disposable[] = [];
        window.onDidChangeTextEditorSelection(() => this._onFocusSignal('selection'), this, subscriptions);
        window.onDidChangeActiveTextEditor((editor) => this._onActiveEditorChanged(editor), this, subscriptions);
        window.onDidChangeWindowState((state) => this._onWindowStateChanged(state), this, subscriptions);
        workspace.onDidChangeTextDocument((event) => this._onTextDocumentChanged(event), this, subscriptions);
        workspace.onDidSaveTextDocument((document) => this._onDocumentSaved(document), this, subscriptions);
        this._disposable = Disposable.from(...subscriptions, this._statusBarItem);
    }

    public init() {
        this._config = this._loadConfigurations();
        this._startTicker();
        this._startConnectionHealthCheck();
        void this._refreshConnectionStatus('startup', true);
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
        this._stopConnectionHealthCheck();
        this._disposeRepoSubscriptions();
        this._disposable.dispose();
    }

    // 状态栏点击后展示当前连接状态，并允许直接触发重连。
    public async showConnectionStatus(): Promise<void> {
        const reconnectAction = '立即重连';
        const message = [
            `ActivityWatch 当前状态：${this._getConnectionStateLabel()}`,
            `最近成功通信：${formatTimestamp(this._lastSuccessfulContactAtMs)}`,
            `最近错误：${this._lastConnectionErrorMessage ? this._lastConnectionErrorMessage : '无'}`
        ].join(' | ');
        const action = this._connectionState === 'disconnected'
            ? await window.showWarningMessage(message, reconnectAction)
            : await window.showInformationMessage(message, reconnectAction);
        if (action === reconnectAction) {
            await this.reconnect();
        }
    }

    // 手动重连会重新探测服务并重建 bucket。
    public async reconnect(): Promise<void> {
        await this._refreshConnectionStatus('manual-reconnect', true);
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

    private async _ensureBucket(bucket: IBucketInfo): Promise<boolean> {
        try {
            await this._client.ensureBucket(bucket.id, bucket.eventType, bucket.hostName);
            return true;
        } catch (err) {
            const error = this._asError(err);
            this._handleError(`Couldn't create bucket ${bucket.eventType}: ${error.message}`, true);
            console.error(err);
            return false;
        }
    }

    // 两类 bucket 各自创建，单个失败不影响其他轨道。
    private async _ensureAllBuckets(): Promise<boolean> {
        const bucketKinds: BucketKind[] = ['fileActivity', 'gitCommit'];
        const results = await Promise.all(bucketKinds.map(async (bucketKind) => {
            const created = await this._ensureBucket(this._buckets[bucketKind]);
            this._bucketCreated[bucketKind] = created;
            return created;
        }));
        return results.every((created) => created);
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
        const enableCommitArchive = extConfigurations.get<boolean>('enableCommitArchive', true);
        const commitBackfillCount = extConfigurations.get<number>('commitBackfillCount', 20);
        const includeAuthorPII = extConfigurations.get<boolean>('includeAuthorPII', false);
        return {
            maxHeartbeatsPerSec: timingConfig.maxHeartbeatsPerSec,
            fileActivityPulseTimeSec: timingConfig.fileActivityPulseTimeSec,
            textChangeDebounceMs: timingConfig.textChangeDebounceMs,
            enableCommitArchive,
            commitBackfillCount,
            includeAuthorPII
        };
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

    // 周期性探测 AW 服务，避免 server 重启后扩展停在失效连接上。
    private _startConnectionHealthCheck() {
        this._stopConnectionHealthCheck();
        this._connectionHealthHandle = setInterval(() => {
            void this._refreshConnectionStatus('interval-health-check', this._hasMissingBuckets());
        }, this._connectionHealthIntervalMs);
    }

    private _stopConnectionHealthCheck() {
        if (this._connectionHealthHandle) {
            clearInterval(this._connectionHealthHandle);
            this._connectionHealthHandle = undefined;
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
            void this._refreshConnectionStatus('file-activity-missing-bucket', true);
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

    private _sendHeartbeat(bucketKind: BucketKind, pulseTimeSec: number, event: IEvent): Promise<void> {
        if (!this._bucketCreated[bucketKind]) {
            void this._refreshConnectionStatus(`${bucketKind}-heartbeat-skipped`, true);
            return Promise.resolve();
        }
        const bucket = this._buckets[bucketKind];
        return this._client.heartbeat(bucket.id, pulseTimeSec, event)
            .catch((err: Error) => {
                console.error('sendHeartbeat error:', err);
                this._markDisconnected(`Heartbeat failed: ${err.message}`, true);
                void this._refreshConnectionStatus('heartbeat-send-failed', true);
            });
    }

    // 非连续型事件（commit）使用 insertEvent，保留独立段落不被合并。
    private _sendEvent(bucketKind: BucketKind, event: IEvent): Promise<IEvent | undefined> {
        if (!this._bucketCreated[bucketKind]) {
            void this._refreshConnectionStatus(`${bucketKind}-event-skipped`, true);
            return Promise.resolve(undefined);
        }
        const bucket = this._buckets[bucketKind];
        return this._client.insertEvent(bucket.id, event)
            .catch((err: Error) => {
                console.error('sendEvent error:', err);
                this._markDisconnected(`Event send failed: ${err.message}`, true);
                void this._refreshConnectionStatus('event-send-failed', true);
                return undefined;
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
        if (!this._config.enableCommitArchive) {
            return;
        }
        if (!this._bucketCreated.gitCommit) {
            void this._refreshConnectionStatus('commit-missing-bucket', true);
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
        if (!this._config.enableCommitArchive || !this._git) {
            return;
        }
        if (!this._bucketCreated.gitCommit) {
            void this._refreshConnectionStatus('commit-backfill-missing-bucket', true);
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
                body: details.body
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

    // 统一执行服务探测与 bucket 重建，让断联后的 watcher 能自动恢复。
    private async _refreshConnectionStatus(reason: string, forceBucketEnsure: boolean): Promise<boolean> {
        if (this._connectionCheckInFlight) {
            return false;
        }
        this._connectionCheckInFlight = true;
        console.log(`[ActivityWatch] connection check start: reason=${reason}, forceBucketEnsure=${forceBucketEnsure}`);
        if (reason === 'startup' || reason === 'manual-reconnect') {
            this._setConnectionState('connecting');
        }
        try {
            await this._client.getInfo();
            console.log('[ActivityWatch] getInfo ok');
            this._markConnected();
            if (forceBucketEnsure || this._hasMissingBuckets()) {
                const bucketReady = await this._ensureAllBuckets();
                if (!bucketReady) {
                    console.warn(`[ActivityWatch] bucket ensure failed: reason=${reason}`);
                    this._markDisconnected(`Bucket 初始化失败（${reason}）`, false);
                    return false;
                }
            }
            console.log(`[ActivityWatch] connection ready: reason=${reason}`);
            this._markConnected();
            return true;
        } catch (err) {
            const error = this._asError(err);
            console.error(`[ActivityWatch] connection check failed: reason=${reason}`, error);
            this._markDisconnected(`AW 服务不可达（${reason}）：${error.message}`, false);
            return false;
        } finally {
            this._connectionCheckInFlight = false;
        }
    }

    private _hasMissingBuckets(): boolean {
        const bucketKinds: BucketKind[] = ['fileActivity', 'gitCommit'];
        return bucketKinds.some((bucketKind) => !this._bucketCreated[bucketKind]);
    }

    // 根据内部状态统一刷新状态栏展示与可访问标签。
    private _refreshStatusBar() {
        const presentation = buildConnectionStatusPresentation({
            state: this._connectionState,
            lastSuccessfulContactAtMs: this._lastSuccessfulContactAtMs,
            lastErrorMessage: this._lastConnectionErrorMessage
        });
        this._statusBarItem.text = presentation.text;
        this._statusBarItem.tooltip = presentation.tooltip;
        if (this._connectionState === 'disconnected') {
            this._statusBarItem.color = new ThemeColor('statusBarItem.errorForeground');
            return;
        }
        if (this._connectionState === 'connecting') {
            this._statusBarItem.color = new ThemeColor('statusBarItem.warningForeground');
            return;
        }
        this._statusBarItem.color = undefined;
    }

    private _setConnectionState(state: ActivityWatchConnectionState, lastErrorMessage?: string) {
        const previousState = this._connectionState;
        this._connectionState = state;
        if (typeof lastErrorMessage === 'string') {
            this._lastConnectionErrorMessage = lastErrorMessage;
        }
        if (state === 'connected') {
            this._lastSuccessfulContactAtMs = Date.now();
            this._lastConnectionErrorMessage = '';
        }
        this._refreshStatusBar();
        if (previousState === state) {
            return;
        }
        if (state === 'disconnected') {
            window.showWarningMessage('[ActivityWatch] 已断开连接，点击右下角 AW 状态可查看详情并重连。');
            return;
        }
        if (state === 'connected' && previousState === 'disconnected') {
            window.showInformationMessage('[ActivityWatch] 已重新连接并恢复推送。');
        }
    }

    private _markConnected() {
        this._setConnectionState('connected');
    }

    private _markDisconnected(message: string, showCriticalError: boolean) {
        this._setConnectionState('disconnected', message);
        if (showCriticalError) {
            this._handleError(message, true);
        }
    }

    private _getConnectionStateLabel(): string {
        if (this._connectionState === 'connected') {
            return '已连接';
        }
        if (this._connectionState === 'connecting') {
            return '连接中';
        }
        return '已断开';
    }

    private _asError(err: unknown): Error {
        if (err instanceof Error) {
            return err;
        }
        if (typeof err === 'string') {
            return new Error(err);
        }
        const candidate = err as { message?: unknown };
        if (typeof candidate.message === 'string') {
            return new Error(candidate.message);
        }
        return new Error('Unknown error');
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
