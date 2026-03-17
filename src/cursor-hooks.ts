import * as fs from 'fs';
import * as path from 'path';
import { platform } from 'os';
import { ExtensionContext, window } from 'vscode';

interface IHookCommand {
    command: string;
    timeout: number;
}

interface IHooksConfig {
    version: number;
    hooks: Record<string, IHookCommand[]>;
}

interface IGlobalHookTargetPaths {
    hooksConfigPath: string;
    hooksDirectoryPath: string;
}

interface IManagedHookDefinition {
    eventName: string;
    sourceCommand: IHookCommand;
    relativeScriptPath: string;
}

interface IHookInstallResult {
    installedScripts: number;
    updatedConfig: boolean;
}

const BUNDLED_HOOKS_CONFIG_RELATIVE_PATH = path.join('.cursor', 'hooks.json');
const BUNDLED_HOOKS_DIRECTORY_RELATIVE_PATH = path.join('.cursor', 'hooks');
const DEFAULT_HOOK_TIMEOUT_SEC = 10;
const MANAGED_HOOK_COMMAND_PATTERN = /\.cursor[\\/]+hooks[\\/]+([^"'\s]+)/;

/**
 * 扩展启动时自动把内置 Cursor Hooks 同步到系统级目录。
 * 这样用户安装扩展后，无需再手动复制 hooks 文件。
 */
export async function installBundledCursorHooks(context: ExtensionContext): Promise<void> {
    try {
        const bundledConfigPath = path.join(context.extensionPath, BUNDLED_HOOKS_CONFIG_RELATIVE_PATH);
        const bundledHooksDirectoryPath = path.join(context.extensionPath, BUNDLED_HOOKS_DIRECTORY_RELATIVE_PATH);
        const bundledConfig = await readHooksConfig(bundledConfigPath);
        const managedHooks = collectManagedHooks(bundledConfig);
        if (managedHooks.length === 0) {
            return;
        }

        const targetPaths = resolveGlobalHookTargetPaths(platform());
        const result = await installManagedHooks({
            bundledHooksDirectoryPath,
            managedHooks,
            targetPaths
        });

        if (result.installedScripts > 0 || result.updatedConfig) {
            console.log(
                `[Cursor Hooks] installed ${result.installedScripts} script(s), updatedConfig=${String(result.updatedConfig)}, target=${targetPaths.hooksConfigPath}`
            );
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[Cursor Hooks] global install skipped: ${message}`);
        void window.showWarningMessage(`[ActivityWatch] Cursor Hooks 自动安装失败：${message}`);
    }
}

/**
 * 解析不同系统下 Cursor 的全局 hooks 目录。
 */
function resolveGlobalHookTargetPaths(platformName: NodeJS.Platform): IGlobalHookTargetPaths {
    let baseDirectoryPath: string;
    if (platformName === 'win32') {
        const programDataPath = process.env.ProgramData && process.env.ProgramData.trim().length > 0
            ? process.env.ProgramData
            : 'C:\\ProgramData';
        baseDirectoryPath = path.join(programDataPath, 'Cursor');
    } else if (platformName === 'darwin') {
        baseDirectoryPath = '/Library/Application Support/Cursor';
    } else {
        baseDirectoryPath = '/etc/cursor';
    }
    return {
        hooksConfigPath: path.join(baseDirectoryPath, 'hooks.json'),
        hooksDirectoryPath: path.join(baseDirectoryPath, 'hooks')
    };
}

/**
 * 从扩展内置 hooks 配置中提取所有需要托管安装的 hook。
 * 只有引用 `.cursor/hooks/*` 的命令会被同步到全局目录。
 */
function collectManagedHooks(config: IHooksConfig): IManagedHookDefinition[] {
    const definitions: IManagedHookDefinition[] = [];
    for (const eventName in config.hooks) {
        const commands = config.hooks[eventName];
        for (let index = 0; index < commands.length; index += 1) {
            const command = commands[index];
            const relativeScriptPath = extractManagedScriptPath(command.command);
            if (!relativeScriptPath) {
                continue;
            }
            definitions.push({
                eventName,
                sourceCommand: command,
                relativeScriptPath
            });
        }
    }
    return definitions;
}

/**
 * 提取命令里引用的 `.cursor/hooks/*` 相对脚本路径。
 */
function extractManagedScriptPath(command: string): string | undefined {
    const matched = MANAGED_HOOK_COMMAND_PATTERN.exec(command);
    if (!matched || matched.length < 2) {
        return undefined;
    }
    return matched[1].replace(/[\\/]+/g, path.sep);
}

/**
 * 执行脚本复制与 hooks.json 合并写入。
 */
async function installManagedHooks(args: {
    bundledHooksDirectoryPath: string;
    managedHooks: IManagedHookDefinition[];
    targetPaths: IGlobalHookTargetPaths;
}): Promise<IHookInstallResult> {
    let installedScripts = 0;
    for (let index = 0; index < args.managedHooks.length; index += 1) {
        const managedHook = args.managedHooks[index];
        const sourceScriptPath = path.join(args.bundledHooksDirectoryPath, managedHook.relativeScriptPath);
        const targetScriptPath = path.join(args.targetPaths.hooksDirectoryPath, managedHook.relativeScriptPath);
        const updated = await copyFileIfChanged(sourceScriptPath, targetScriptPath);
        if (updated) {
            installedScripts += 1;
        }
    }

    const existingConfig = await readHooksConfigIfExists(args.targetPaths.hooksConfigPath);
    const mergedConfig = buildMergedHooksConfig(existingConfig, args.managedHooks, args.targetPaths.hooksDirectoryPath);
    const updatedConfig = await writeJsonIfChanged(args.targetPaths.hooksConfigPath, mergedConfig);
    return {
        installedScripts,
        updatedConfig
    };
}

/**
 * 保留用户已有的非托管 hooks，只替换当前扩展负责维护的那部分。
 */
function buildMergedHooksConfig(
    existingConfig: IHooksConfig,
    managedHooks: IManagedHookDefinition[],
    targetHooksDirectoryPath: string
): IHooksConfig {
    const nextHooks: Record<string, IHookCommand[]> = {};
    for (const eventName in existingConfig.hooks) {
        nextHooks[eventName] = existingConfig.hooks[eventName].map((command) => ({
            command: command.command,
            timeout: command.timeout
        }));
    }

    for (let index = 0; index < managedHooks.length; index += 1) {
        const managedHook = managedHooks[index];
        const globalScriptPath = path.join(targetHooksDirectoryPath, managedHook.relativeScriptPath);
        const normalizedScriptPath = normalizePathForCompare(globalScriptPath);
        const currentCommands = nextHooks[managedHook.eventName] ? nextHooks[managedHook.eventName] : [];
        const remainingCommands = currentCommands.filter((candidate) => {
            return !isManagedCommandMatch(candidate.command, managedHook.relativeScriptPath, normalizedScriptPath);
        });
        remainingCommands.push({
            command: buildGlobalHookCommand(managedHook.sourceCommand.command, globalScriptPath),
            timeout: managedHook.sourceCommand.timeout
        });
        nextHooks[managedHook.eventName] = remainingCommands;
    }

    return {
        version: 1,
        hooks: nextHooks
    };
}

/**
 * 判断现有命令是否属于当前扩展维护的 hook。
 * 同时兼容旧的项目相对路径写法与新的全局绝对路径写法。
 */
function isManagedCommandMatch(command: string, relativeScriptPath: string, normalizedScriptPath: string): boolean {
    const normalizedCommand = normalizePathForCompare(command);
    if (normalizedCommand.indexOf(normalizedScriptPath) >= 0) {
        return true;
    }
    const normalizedRelativePath = normalizePathForCompare(path.join('.cursor', 'hooks', relativeScriptPath));
    return normalizedCommand.indexOf(normalizedRelativePath) >= 0;
}

/**
 * 把项目内相对脚本路径替换成全局目录下的绝对脚本路径。
 * 原始命令里的运行器与额外参数会被保留。
 */
function buildGlobalHookCommand(sourceCommand: string, globalScriptPath: string): string {
    const quotedScriptPath = quoteShellPath(globalScriptPath);
    return sourceCommand.replace(MANAGED_HOOK_COMMAND_PATTERN, quotedScriptPath);
}

/**
 * 为包含空格的路径统一加双引号，避免命令解析错误。
 */
function quoteShellPath(filePath: string): string {
    return `"${filePath}"`;
}

/**
 * 读取并标准化 hooks.json，格式异常时直接抛错，避免覆盖用户已有配置。
 */
async function readHooksConfig(filePath: string): Promise<IHooksConfig> {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseHooksConfig(content, filePath);
}

/**
 * hooks.json 不存在时返回空配置，存在但格式错误时抛错。
 */
async function readHooksConfigIfExists(filePath: string): Promise<IHooksConfig> {
    const exists = await pathExists(filePath);
    if (!exists) {
        return {
            version: 1,
            hooks: {}
        };
    }
    return readHooksConfig(filePath);
}

/**
 * 仅接受我们需要的 hooks 字段，忽略未知字段。
 */
function parseHooksConfig(content: string, filePath: string): IHooksConfig {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`无法解析 ${filePath}: ${message}`);
    }

    if (!isRecord(parsed)) {
        throw new Error(`${filePath} 必须是 JSON 对象`);
    }

    const hooksValue = parsed.hooks;
    const hooks: Record<string, IHookCommand[]> = {};
    if (isRecord(hooksValue)) {
        for (const eventName in hooksValue) {
            hooks[eventName] = normalizeHookCommands(hooksValue[eventName]);
        }
    }

    const versionValue = parsed.version;
    return {
        version: typeof versionValue === 'number' && Number.isFinite(versionValue) ? versionValue : 1,
        hooks
    };
}

/**
 * 标准化单个事件下的命令数组，丢弃无法识别的项。
 */
function normalizeHookCommands(value: unknown): IHookCommand[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const commands: IHookCommand[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const item = value[index];
        if (!isRecord(item) || typeof item.command !== 'string') {
            continue;
        }
        commands.push({
            command: item.command,
            timeout: typeof item.timeout === 'number' && Number.isFinite(item.timeout)
                ? item.timeout
                : DEFAULT_HOOK_TIMEOUT_SEC
        });
    }
    return commands;
}

/**
 * 复制脚本时只在内容发生变化后写入，避免无意义地改动目标文件时间戳。
 */
async function copyFileIfChanged(sourceFilePath: string, targetFilePath: string): Promise<boolean> {
    const content = fs.readFileSync(sourceFilePath, 'utf8');
    return writeTextIfChanged(targetFilePath, content);
}

/**
 * 写入 JSON 前统一格式化，便于排查与人工维护。
 */
async function writeJsonIfChanged(filePath: string, value: IHooksConfig): Promise<boolean> {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    return writeTextIfChanged(filePath, content);
}

/**
 * 仅在文件内容变化时写入，并自动确保父目录存在。
 */
async function writeTextIfChanged(filePath: string, content: string): Promise<boolean> {
    const existingContent = await readTextIfExists(filePath);
    if (existingContent === content) {
        return false;
    }
    ensureDirectoryExists(path.dirname(filePath));
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
}

/**
 * 读取可选文本文件，不存在时返回 undefined。
 */
async function readTextIfExists(filePath: string): Promise<string | undefined> {
    const exists = await pathExists(filePath);
    if (!exists) {
        return undefined;
    }
    return fs.readFileSync(filePath, 'utf8');
}

/**
 * 小型路径存在判断，避免把“不存在”和“其他 I/O 错误”混在一起。
 */
async function pathExists(targetPath: string): Promise<boolean> {
    return fs.existsSync(targetPath);
}

/**
 * 统一大小写与路径分隔符，方便跨平台比较命令中的路径片段。
 */
function normalizePathForCompare(value: string): string {
    return value.replace(/[\\/]+/g, '/').toLowerCase();
}

/**
 * 兼容当前项目的旧版 Node 类型定义，递归确保目录存在。
 */
function ensureDirectoryExists(directoryPath: string): void {
    if (fs.existsSync(directoryPath)) {
        return;
    }
    const parentDirectoryPath = path.dirname(directoryPath);
    if (parentDirectoryPath !== directoryPath) {
        ensureDirectoryExists(parentDirectoryPath);
    }
    fs.mkdirSync(directoryPath);
}

/**
 * 受控的对象类型守卫，避免使用 any。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
