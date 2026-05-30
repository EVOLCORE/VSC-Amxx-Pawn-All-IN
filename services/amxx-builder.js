const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const AMXX_BUILDER_BUILD_COMMAND_ID = 'amxxPawnAllIn.amxxBuilderBuild';
const AMXX_BUILDER_INIT_COMMAND_ID = 'amxxPawnAllIn.amxxBuilderInit';
const AMXX_BUILDER_INSTALL_COMMAND_ID = 'amxxPawnAllIn.amxxBuilderInstallOrUpdate';
const AMXX_BUILDER_AVAILABLE_CONTEXT = 'amxxPawnAllIn.amxxBuilderAvailable';
const AMXX_BUILDER_MANIFEST_CONTEXT = 'amxxPawnAllIn.amxxBuilderManifestAvailable';
const AMXX_BUILDER_EXECUTABLE = 'amxb';
const AMXX_BUILDER_PROBE_TIMEOUT_MS = 2500;
const AMXX_BUILDER_TERMINAL_NAME = 'AMXX Builder';
const AMXX_BUILDER_OUTPUT_CHANNEL_NAME = 'AMXX Builder';
const AMXX_BUILDER_TERMINAL_OWNER_ENV = 'AMXX_PAWN_ALL_IN_TERMINAL';
const AMXX_BUILDER_TERMINAL_OWNER_VALUE = 'amxx-builder';
const AMXX_BUILDER_MANIFEST_NAMES = [
    'amxbuild.yml',
    'amxbuild.yaml'
];
const AMXX_BUILDER_MANIFEST_SUFFIXES = [
    '.yml',
    '.yaml'
];
const WATCH_GLOB = '{amxbuild.yml,amxbuild.yaml,ambuild.*.yml,ambuild.*.yaml}';
const AMXX_BUILDER_INIT_OPTION_IDS = {
    NAME: 'name',
    PLUGIN: 'plugin',
    WORKFLOW: 'workflow',
    DEPLOY: 'deploy',
    GITIGNORE: 'gitignore'
};
let runtimeTranslator = null;
let notificationHelpers = null;

function t(key, fallback = '') {
    if (!runtimeTranslator) {
        const { createRuntimeLocalization } = require('./localization');
        runtimeTranslator = createRuntimeLocalization(vscode);
    }
    return runtimeTranslator.t(key, null, fallback || null);
}

function getNotificationHelpers() {
    if (!notificationHelpers) {
        notificationHelpers = require('./notifications');
    }
    return notificationHelpers;
}

function normalizeFsPath(filePath) {
    return String(filePath || '')
        .replace(/\\/g, '/')
        .toLowerCase();
}

function escapeTerminalArg(value) {
    const text = String(value || '');
    if (!text) return '""';
    if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
    return `"${text.replace(/"/g, '\\"')}"`;
}

function normalizeInitOptionText(value) {
    return String(value || '').trim();
}

function buildInitCommand(options = {}) {
    const args = ['init'];
    const packageName = normalizeInitOptionText(options.name);
    const pluginName = normalizeInitOptionText(options.plugin);
    if (packageName) {
        args.push('--name', escapeTerminalArg(packageName));
    }
    if (options.workflow) {
        args.push('--workflow');
    }
    if (pluginName) {
        args.push('--plugin', escapeTerminalArg(pluginName));
    }
    if (options.gitignore) {
        args.push('--gitignore');
    }
    if (options.deploy) {
        args.push('--deploy');
    }
    return `${AMXX_BUILDER_EXECUTABLE} ${args.join(' ')}`;
}

function isAmxxBuilderManifestName(fileName) {
    const name = String(fileName || '').trim().toLowerCase();
    if (AMXX_BUILDER_MANIFEST_NAMES.includes(name)) return true;
    return AMXX_BUILDER_MANIFEST_SUFFIXES.some(suffix =>
        name.startsWith('ambuild.') && name.endsWith(suffix) && name.length > `ambuild.${suffix}`.length
    );
}

function readDirectoryManifestFiles(rootDir) {
    if (!rootDir) return [];
    let entries = [];
    try {
        entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter(entry => entry.isFile() && isAmxxBuilderManifestName(entry.name))
        .map(entry => path.join(rootDir, entry.name))
        .sort((left, right) => {
            const leftName = path.basename(left).toLowerCase();
            const rightName = path.basename(right).toLowerCase();
            const leftDefault = AMXX_BUILDER_MANIFEST_NAMES.includes(leftName) ? 0 : 1;
            const rightDefault = AMXX_BUILDER_MANIFEST_NAMES.includes(rightName) ? 0 : 1;
            return leftDefault - rightDefault || leftName.localeCompare(rightName);
        });
}

function getActiveWorkspaceFolder() {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document?.uri) {
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (folder) return folder;
    }
    const folders = vscode.workspace.workspaceFolders || [];
    return folders[0] || null;
}

function getTerminalCacheKey(cwd) {
    if (!cwd) return '<default>';
    return normalizeFsPath(path.resolve(String(cwd)));
}

function isReusableTerminal(windowApi, terminal) {
    if (!terminal) return false;
    if (terminal.exitStatus) return false;
    const openTerminals = windowApi?.terminals;
    return !Array.isArray(openTerminals) || openTerminals.includes(terminal);
}

function getTerminalCreationCwd(terminal) {
    const cwd = terminal?.creationOptions?.cwd ?? terminal?.options?.cwd;
    if (!cwd) return '';
    if (typeof cwd === 'string') return cwd;
    return cwd.fsPath || cwd.path || '';
}

function hasBuilderTerminalOwnerMarker(terminal) {
    const env = terminal?.creationOptions?.env ?? terminal?.options?.env;
    return env?.[AMXX_BUILDER_TERMINAL_OWNER_ENV] === AMXX_BUILDER_TERMINAL_OWNER_VALUE;
}

function findReusableTerminal(windowApi, cwd) {
    const openTerminals = windowApi?.terminals;
    if (!Array.isArray(openTerminals)) return null;
    const key = getTerminalCacheKey(cwd);
    return openTerminals.find(terminal =>
        terminal?.name === AMXX_BUILDER_TERMINAL_NAME &&
        isReusableTerminal(windowApi, terminal) &&
        getTerminalCacheKey(getTerminalCreationCwd(terminal)) === key
    ) || null;
}

function createBuilderTerminalManager(windowApi = vscode.window) {
    const terminalByCwd = new Map();
    const ownedTerminals = new Set();

    function getTerminal(cwd) {
        const key = getTerminalCacheKey(cwd);
        const cachedTerminal = terminalByCwd.get(key);
        if (isReusableTerminal(windowApi, cachedTerminal)) {
            return cachedTerminal;
        }
        if (cachedTerminal) {
            forgetTerminal(cachedTerminal);
        }

        const existingTerminal = findReusableTerminal(windowApi, cwd);
        if (existingTerminal) {
            terminalByCwd.set(key, existingTerminal);
            if (hasBuilderTerminalOwnerMarker(existingTerminal)) {
                ownedTerminals.add(existingTerminal);
            }
            return existingTerminal;
        }

        const terminal = windowApi.createTerminal({
            name: AMXX_BUILDER_TERMINAL_NAME,
            cwd: cwd || undefined,
            env: {
                [AMXX_BUILDER_TERMINAL_OWNER_ENV]: AMXX_BUILDER_TERMINAL_OWNER_VALUE
            }
        });
        terminalByCwd.set(key, terminal);
        ownedTerminals.add(terminal);
        return terminal;
    }

    function forgetTerminal(terminal) {
        for (const [key, cachedTerminal] of terminalByCwd.entries()) {
            if (cachedTerminal === terminal) {
                terminalByCwd.delete(key);
            }
        }
        ownedTerminals.delete(terminal);
    }

    function dispose() {
        const terminals = [...ownedTerminals];
        terminalByCwd.clear();
        ownedTerminals.clear();
        for (const terminal of terminals) {
            try {
                terminal?.dispose?.();
            } catch {}
        }
    }

    return {
        dispose,
        forgetTerminal,
        getTerminal,
        _getCachedTerminalCount: () => terminalByCwd.size,
        _getOwnedTerminalCount: () => ownedTerminals.size
    };
}

function probeAmxxBuilder() {
    return new Promise(resolve => {
        const { spawn } = require('child_process');
        let done = false;
        const child = spawn(AMXX_BUILDER_EXECUTABLE, ['--help'], {
            shell: process.platform === 'win32',
            windowsHide: true
        });
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            try {
                child.kill();
            } catch {}
            resolve(false);
        }, AMXX_BUILDER_PROBE_TIMEOUT_MS);
        const finish = value => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(value);
        };
        child.on('error', () => finish(false));
        child.on('exit', code => finish(code === 0));
        child.on('close', code => finish(code === 0));
    });
}

function registerAmxxBuilderIntegration(context) {
    const manifestsByWorkspace = new Map();
    let outputChannel = null;
    let builderAvailable = false;
    let refreshSerial = 0;
    const terminalManager = createBuilderTerminalManager(vscode.window);

    function getOutputChannel() {
        if (!outputChannel) {
            outputChannel = vscode.window.createOutputChannel(AMXX_BUILDER_OUTPUT_CHANNEL_NAME);
            context.subscriptions.push(outputChannel);
        }
        return outputChannel;
    }

    function getWorkspaceManifests(folder = getActiveWorkspaceFolder()) {
        if (!folder?.uri?.fsPath) return [];
        return manifestsByWorkspace.get(normalizeFsPath(folder.uri.fsPath)) || [];
    }

    function hasManifestInActiveWorkspace() {
        return getWorkspaceManifests().length > 0;
    }

    function updateContexts() {
        const hasManifest = hasManifestInActiveWorkspace();
        vscode.commands.executeCommand('setContext', AMXX_BUILDER_MANIFEST_CONTEXT, hasManifest).then(
            undefined,
            () => {}
        );
        vscode.commands.executeCommand('setContext', AMXX_BUILDER_AVAILABLE_CONTEXT, hasManifest && builderAvailable).then(
            undefined,
            () => {}
        );
    }

    async function refreshManifestsAndToolState() {
        const serial = ++refreshSerial;
        manifestsByWorkspace.clear();
        let hasAnyManifest = false;
        for (const folder of vscode.workspace.workspaceFolders || []) {
            const manifests = readDirectoryManifestFiles(folder.uri.fsPath);
            if (manifests.length) hasAnyManifest = true;
            manifestsByWorkspace.set(normalizeFsPath(folder.uri.fsPath), manifests);
        }
        if (!hasAnyManifest) {
            builderAvailable = false;
            updateContexts();
            return;
        }
        const nextBuilderAvailable = await probeAmxxBuilder();
        if (serial !== refreshSerial) return;
        builderAvailable = nextBuilderAvailable;
        updateContexts();
    }

    async function pickManifest(folder) {
        const manifests = getWorkspaceManifests(folder);
        if (!manifests.length) return '';
        if (manifests.length === 1) return manifests[0];

        const selected = await vscode.window.showQuickPick(
            manifests.map(manifestPath => ({
                label: path.basename(manifestPath),
                description: path.dirname(manifestPath),
                manifestPath
            })),
            {
                placeHolder: t('amxxBuilder.pickManifest')
            }
        );
        return selected?.manifestPath || '';
    }

    function runBuildTerminal(folder, manifestPath) {
        const workspaceRoot = folder?.uri?.fsPath || path.dirname(manifestPath || '') || undefined;
        const terminal = terminalManager.getTerminal(workspaceRoot);
        const manifestName = path.basename(manifestPath || '');
        const defaultManifest = AMXX_BUILDER_MANIFEST_NAMES.includes(manifestName.toLowerCase());
        const command = defaultManifest
            ? `${AMXX_BUILDER_EXECUTABLE} build`
            : `${AMXX_BUILDER_EXECUTABLE} build ${escapeTerminalArg(manifestName)}`;
        terminal.show(true);
        terminal.sendText(command);
        const channel = getOutputChannel();
        channel.appendLine(`[amxx-builder] cwd=${workspaceRoot || ''}`);
        channel.appendLine(`[amxx-builder] ${command}`);
    }

    async function offerInit(folder) {
        const createLabel = t('amxxBuilder.createManifest');
        const { showTimedInformationMessage } = getNotificationHelpers();
        const selection = await showTimedInformationMessage(vscode,
            t('amxxBuilder.noManifest'),
            createLabel
        );
        if (selection === createLabel) {
            return runInit(folder);
        }
        return undefined;
    }

    async function runBuild() {
        await refreshManifestsAndToolState();
        const folder = getActiveWorkspaceFolder();
        if (!folder) {
            const { showTimedErrorMessage } = getNotificationHelpers();
            showTimedErrorMessage(vscode, t('amxxBuilder.noWorkspace'));
            return;
        }
        if (!builderAvailable) {
            const installLabel = t('amxxBuilder.installOrUpdate');
            const { showTimedErrorMessage } = getNotificationHelpers();
            const selection = await showTimedErrorMessage(vscode,
                t('amxxBuilder.notFound'),
                installLabel
            );
            if (selection === installLabel) {
                runInstallOrUpdate();
            }
            return;
        }

        const manifestPath = await pickManifest(folder);
        if (!manifestPath) {
            await offerInit(folder);
            return;
        }
        runBuildTerminal(folder, manifestPath);
    }

    async function runInit(folder = getActiveWorkspaceFolder()) {
        if (!folder?.uri?.fsPath) {
            const { showTimedErrorMessage } = getNotificationHelpers();
            showTimedErrorMessage(vscode, t('amxxBuilder.noWorkspace'));
            return;
        }
        const options = await promptAmxxBuilderInitOptions(vscode.window);
        if (!options) return;
        const command = buildInitCommand(options);
        const terminal = terminalManager.getTerminal(folder.uri.fsPath);
        terminal.show(true);
        terminal.sendText(command);
        const channel = getOutputChannel();
        channel.appendLine(`[amxx-builder] cwd=${folder.uri.fsPath}`);
        channel.appendLine(`[amxx-builder] ${command}`);
    }

    function runInstallOrUpdate() {
        const terminal = terminalManager.getTerminal();
        terminal.show(true);
        if (process.platform === 'win32') {
            terminal.sendText('irm https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/install.ps1 | iex');
        } else {
            terminal.sendText('curl -fsSL https://raw.githubusercontent.com/AmxxModularEcosystem/amxx-builder/master/install.sh | bash');
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand(AMXX_BUILDER_BUILD_COMMAND_ID, runBuild),
        vscode.commands.registerCommand(AMXX_BUILDER_INIT_COMMAND_ID, () => runInit()),
        vscode.commands.registerCommand(AMXX_BUILDER_INSTALL_COMMAND_ID, runInstallOrUpdate),
        vscode.window.onDidChangeActiveTextEditor(updateContexts),
        vscode.workspace.onDidChangeWorkspaceFolders(refreshManifestsAndToolState),
        terminalManager
    );
    if (typeof vscode.window.onDidCloseTerminal === 'function') {
        context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
            terminalManager.forgetTerminal(terminal);
        }));
    }

    const watcher = vscode.workspace.createFileSystemWatcher(WATCH_GLOB);
    context.subscriptions.push(
        watcher,
        watcher.onDidCreate(refreshManifestsAndToolState),
        watcher.onDidDelete(refreshManifestsAndToolState),
        watcher.onDidChange(refreshManifestsAndToolState)
    );

    refreshManifestsAndToolState();

    return {
        refreshManifestsAndToolState,
        getWorkspaceManifests
    };
}

function getInitOptionItems() {
    return [
        {
            id: AMXX_BUILDER_INIT_OPTION_IDS.NAME,
            label: t('amxxBuilder.init.option.name'),
            description: '--name <name>',
            detail: t('amxxBuilder.init.option.name.detail')
        },
        {
            id: AMXX_BUILDER_INIT_OPTION_IDS.PLUGIN,
            label: t('amxxBuilder.init.option.plugin'),
            description: '--plugin <name>',
            detail: t('amxxBuilder.init.option.plugin.detail')
        },
        {
            id: AMXX_BUILDER_INIT_OPTION_IDS.WORKFLOW,
            label: t('amxxBuilder.init.option.workflow'),
            description: '--workflow',
            detail: t('amxxBuilder.init.option.workflow.detail')
        },
        {
            id: AMXX_BUILDER_INIT_OPTION_IDS.GITIGNORE,
            label: t('amxxBuilder.init.option.gitignore'),
            description: '--gitignore',
            detail: t('amxxBuilder.init.option.gitignore.detail')
        },
        {
            id: AMXX_BUILDER_INIT_OPTION_IDS.DEPLOY,
            label: t('amxxBuilder.init.option.deploy'),
            description: '--deploy',
            detail: t('amxxBuilder.init.option.deploy.detail')
        }
    ];
}

async function promptAmxxBuilderInitOptions(windowApi = vscode.window) {
    const selectedItems = await windowApi.showQuickPick(getInitOptionItems(), {
        canPickMany: true,
        ignoreFocusOut: true,
        placeHolder: t('amxxBuilder.init.pickOptions')
    });
    if (!selectedItems) return null;

    const selectedIds = new Set(selectedItems.map(item => item.id));
    const options = {
        workflow: selectedIds.has(AMXX_BUILDER_INIT_OPTION_IDS.WORKFLOW),
        gitignore: selectedIds.has(AMXX_BUILDER_INIT_OPTION_IDS.GITIGNORE),
        deploy: selectedIds.has(AMXX_BUILDER_INIT_OPTION_IDS.DEPLOY)
    };

    if (selectedIds.has(AMXX_BUILDER_INIT_OPTION_IDS.NAME)) {
        const name = await windowApi.showInputBox({
            ignoreFocusOut: true,
            placeHolder: t('amxxBuilder.init.name.placeholder'),
            prompt: t('amxxBuilder.init.name.prompt')
        });
        if (name == null) return null;
        options.name = normalizeInitOptionText(name);
    }

    if (selectedIds.has(AMXX_BUILDER_INIT_OPTION_IDS.PLUGIN)) {
        const plugin = await windowApi.showInputBox({
            ignoreFocusOut: true,
            placeHolder: t('amxxBuilder.init.plugin.placeholder'),
            prompt: t('amxxBuilder.init.plugin.prompt')
        });
        if (plugin == null) return null;
        options.plugin = normalizeInitOptionText(plugin);
    }

    return options;
}

module.exports = {
    AMXX_BUILDER_AVAILABLE_CONTEXT,
    AMXX_BUILDER_BUILD_COMMAND_ID,
    AMXX_BUILDER_INIT_COMMAND_ID,
    AMXX_BUILDER_INSTALL_COMMAND_ID,
    AMXX_BUILDER_MANIFEST_CONTEXT,
    isAmxxBuilderManifestName,
    registerAmxxBuilderIntegration,
    _test: {
        buildInitCommand,
        escapeTerminalArg,
        createBuilderTerminalManager,
        getTerminalCacheKey,
        promptAmxxBuilderInitOptions,
        isAmxxBuilderManifestName,
        readDirectoryManifestFiles
    }
};
