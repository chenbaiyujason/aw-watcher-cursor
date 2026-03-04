import {
    Disposable,
    Extension,
    ExtensionContext,
    commands,
    extensions,
    window,
    workspace
} from 'vscode';
import { hostname } from 'os';
import { execFile } from 'child_process';
import { AWClient, IEvent } from '../aw-client-js/src/aw-client';
import { API, GitExtension, Repository } from './git';
import {
    BUCKET_EVENT_TYPE_AGENT,
    BUCKET_EVENT_TYPE_COMMIT,
    BUCKET_EVENT_TYPE_EDITOR,
    IAgentEventData,
    ICommonEventContext,
    IProjectEventData,
    createAgentEvent,
    createCommitArchiveEvent,
    createProjectEvent,
    createSessionId
} from './events';

interface IWatcherConfig {
    maxHeartbeatsPerSec: number;
    pulseTimeSec: number;
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

    private _editorBucket: IBucketInfo;
    private _agentBucket: IBucketInfo;
    private _commitBucket: IBucketInfo;
    private _editorBucketCreated: boolean = false;
    private _agentBucketCreated: boolean = false;
    private _commitBucketCreated: boolean = false;

    // 编辑器状态缓存，用于去重和限流。
    private _lastFilePath: string = '';
    private _lastBranch: string = '';
    private _lastEditorHeartbeatTime: number = 0;
    private _editorSessionId: string = createSessionId('editor');

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
        const bucketId = `${clientName}_${hostName}`;
        this._editorBucket = {
            id: `${bucketId}_editor`,
            hostName,
            clientName,
            eventType: BUCKET_EVENT_TYPE_EDITOR
        };
        this._agentBucket = {
            id: `${bucketId}_agent`,
            hostName,
            clientName,
            eventType: BUCKET_EVENT_TYPE_AGENT
        };
        this._commitBucket = {
            id: `${bucketId}_commit`,
            hostName,
            clientName,
            eventType: BUCKET_EVENT_TYPE_COMMIT
        };
        this._client = new AWClient(clientName, { testing: false });
        this._config = this._loadConfigurations();

        const subscriptions: Disposable[] = [];
        window.onDidChangeTextEditorSelection(() => this._onEditorEvent('selection'), this, subscriptions);
        window.onDidChangeActiveTextEditor(() => this._onEditorEvent('active-editor'), this, subscriptions);
        workspace.onDidSaveTextDocument(() => this._onEditorEvent('periodic'), this, subscriptions);
        this._registerAgentCommandWatcher(subscriptions);
        this._disposable = Disposable.from(...subscriptions);
    }

    public init() {
        this._config = this._loadConfigurations();
        this._ensureBucket(this._editorBucket, (created) => this._editorBucketCreated = created);
        if (this._config.enableAgentReport) {
            this._ensureBucket(this._agentBucket, (created) => this._agentBucketCreated = created);
        } else {
            this._agentBucketCreated = false;
        }
        if (this._config.enableCommitArchive) {
            this._ensureBucket(this._commitBucket, (created) => this._commitBucketCreated = created);
        } else {
            this._commitBucketCreated = false;
        }
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
        this._disposeRepoSubscriptions();
        this._disposable.dispose();
    }

    public showAgentCommandMapping() {
        const mappingText = JSON.stringify(this._config.commandMapping, undefined, 2);
        window.showInformationMessage(`ActivityWatch agent mapping: ${mappingText}`);
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
        const maxHeartbeatsPerSec = extConfigurations.get<number>('maxHeartbeatsPerSec', 1);
        const pulseTimeSec = extConfigurations.get<number>('pulseTimeSec', 20);
        const enableAgentReport = extConfigurations.get<boolean>('enableAgentReport', true);
        const enableCommitArchive = extConfigurations.get<boolean>('enableCommitArchive', true);
        const commitBackfillCount = extConfigurations.get<number>('commitBackfillCount', 20);
        const includeAuthorPII = extConfigurations.get<boolean>('includeAuthorPII', false);
        const mappingVersion = extConfigurations.get<string>('mappingVersion', 'v1');
        const commandMapping = this._readCommandMapping(extConfigurations.get<unknown>('agentCommandMapping'));
        return {
            maxHeartbeatsPerSec,
            pulseTimeSec,
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

    private _onEditorEvent(trigger: IProjectEventData['trigger']) {
        if (!this._editorBucketCreated) {
            return;
        }
        const contextData = this._getCommonContext();
        const curTime = Date.now();
        const heartbeatInterval = 1000 / this._config.maxHeartbeatsPerSec;
        const shouldSend = contextData.file !== this._lastFilePath ||
            contextData.branch !== this._lastBranch ||
            this._lastEditorHeartbeatTime + heartbeatInterval < curTime;
        if (!shouldSend) {
            return;
        }
        this._lastFilePath = contextData.file;
        this._lastBranch = contextData.branch;
        this._lastEditorHeartbeatTime = curTime;
        const event = createProjectEvent({
            project: contextData.project,
            file: contextData.file,
            language: contextData.language,
            branch: contextData.branch,
            workspaceId: contextData.workspaceId,
            editorSessionId: this._editorSessionId,
            trigger
        });
        this._sendHeartbeat(this._editorBucket.id, event);
    }

    private _onCommandExecuted(commandId: string) {
        if (!this._config.enableAgentReport || !this._agentBucketCreated) {
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
        this._sendHeartbeat(this._agentBucket.id, event);
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
        return undefined;
    }

    // 支持“等值 + 前缀 + 包含”三种匹配，兼容命令 ID 变体。
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

    private _sendHeartbeat<T extends object>(bucketId: string, event: IEvent<T>) {
        return this._client.heartbeat(bucketId, this._config.pulseTimeSec, event)
            .catch((err: Error) => {
                console.error('sendHeartbeat error:', err);
                this._handleError('Error while sending heartbeat', true);
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
        if (!this._config.enableCommitArchive || !this._commitBucketCreated) {
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
        if (!this._config.enableCommitArchive || !this._commitBucketCreated || !this._git) {
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
            await this._sendHeartbeat(this._commitBucket.id, summaryEvent);
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
        if (!editor) {
            return 'unknown';
        }
        const workspaceFolder = workspace.getWorkspaceFolder(editor.document.uri);
        return workspaceFolder ? workspaceFolder.uri.path : 'unknown';
    }

    private _getWorkspaceId(): string {
        const editor = window.activeTextEditor;
        if (!editor) {
            return 'unknown';
        }
        const workspaceFolder = workspace.getWorkspaceFolder(editor.document.uri);
        return workspaceFolder ? workspaceFolder.name : 'unknown';
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
