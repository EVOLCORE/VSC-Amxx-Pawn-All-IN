const { spawn } = require('child_process');
const path = require('path');

// Hover feature shell. It owns provider registration and error isolation,
// while the heavy hover-building logic can continue living elsewhere until we
// extract it in a second step.
function createHoverFeature(deps) {
    const {
        vscode,
        refreshExtensionSettings,
        affectsAnyConfiguration,
        HOVER_RELEVANT_CONFIG_KEYS,
        getHoverMode,
        buildHoverAtPosition
    } = deps;
    const CTRL_HACK_REOPEN_WINDOW_MS = 700;
    const CTRL_HACK_SELECTION_RESTORE_DELAY_MS = 0;
    const CTRL_HACK_RESTART_MIN_DELAY_MS = 800;
    const CTRL_HACK_RESTART_MAX_DELAY_MS = 8000;

    function createWindowsCtrlHackTracker(onStateChange) {
        if (process.platform !== 'win32') {
            return {
                start: () => false,
                stop: () => {},
                isRunning: () => false,
                isPressed: () => false
            };
        }

        let ctrlPressed = false;
        let trackerProcess = null;
        let stdoutBuffer = '';
        let restartTimer = null;
        let restartDelayMs = CTRL_HACK_RESTART_MIN_DELAY_MS;
        let disposed = false;
        const powershellPath = path.join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe'
        );

        const clearRestartTimer = () => {
            if (restartTimer) {
                clearTimeout(restartTimer);
                restartTimer = null;
            }
        };

        const emitState = nextState => {
            const normalized = !!nextState;
            if (normalized === ctrlPressed) return;
            ctrlPressed = normalized;
            onStateChange?.(ctrlPressed);
        };

        const stop = () => {
            disposed = true;
            clearRestartTimer();
            if (trackerProcess) {
                trackerProcess.removeAllListeners();
                trackerProcess.stdout?.removeAllListeners();
                trackerProcess.kill();
                trackerProcess = null;
            }
            restartDelayMs = CTRL_HACK_RESTART_MIN_DELAY_MS;
            emitState(false);
        };

        const scheduleRestart = () => {
            if (disposed || trackerProcess) return;
            clearRestartTimer();
            const delayMs = restartDelayMs;
            restartDelayMs = Math.min(
                CTRL_HACK_RESTART_MAX_DELAY_MS,
                restartDelayMs * 2
            );
            restartTimer = setTimeout(() => {
                restartTimer = null;
                start();
            }, delayMs);
        };

        const start = () => {
            if (disposed || process.platform !== 'win32') return false;
            if (trackerProcess) return true;

            const script = [
                `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class NativeKeyboardState { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey); }'`,
                '$last = $null',
                'while ($true) {',
                '    $pressed = ([NativeKeyboardState]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0',
                '    if ($pressed -ne $last) {',
                '        if ($pressed) { [Console]::Out.WriteLine("1") } else { [Console]::Out.WriteLine("0") }',
                '        [Console]::Out.Flush()',
                '        $last = $pressed',
                '    }',
                '    Start-Sleep -Milliseconds 40',
                '}'
            ].join('; ');

            try {
                trackerProcess = spawn(powershellPath, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true
                });
            } catch (err) {
                trackerProcess = null;
                return false;
            }

            trackerProcess.stdout?.setEncoding('utf8');
            trackerProcess.stdout?.on('data', chunk => {
                restartDelayMs = CTRL_HACK_RESTART_MIN_DELAY_MS;
                stdoutBuffer += String(chunk || '');
                const lines = stdoutBuffer.split(/\r?\n/);
                stdoutBuffer = lines.pop() || '';
                for (const line of lines) {
                    const value = String(line || '').trim();
                    if (value === '1') emitState(true);
                    else if (value === '0') emitState(false);
                }
            });
            trackerProcess.stderr?.setEncoding('utf8');
            trackerProcess.stderr?.on('data', () => {});
            trackerProcess.on('exit', (code, signal) => {
                trackerProcess = null;
                stdoutBuffer = '';
                emitState(false);
                scheduleRestart();
            });
            trackerProcess.on('error', () => {
                if (trackerProcess) {
                    trackerProcess.removeAllListeners();
                    trackerProcess.stdout?.removeAllListeners();
                    trackerProcess.stderr?.removeAllListeners();
                    trackerProcess = null;
                }
                emitState(false);
                scheduleRestart();
            });
            return true;
        };

        return {
            start,
            stop,
            isRunning: () => !!trackerProcess,
            isPressed: () => ctrlPressed
        };
    }

    function register(context) {
        let ctrlHackTracker = null;
        let lastCtrlHackDeniedHover = null;

        const getPositionSnapshot = position => ({
            line: Number(position?.line) || 0,
            character: Number(position?.character) || 0
        });
        const isSamePositionSnapshot = (left, right) =>
            !!left &&
            !!right &&
            left.line === right.line &&
            left.character === right.character;
        const cloneSelectionSnapshot = selection => ({
            anchor: getPositionSnapshot(selection?.anchor || selection?.active),
            active: getPositionSnapshot(selection?.active || selection?.anchor),
            isEmpty: !!selection?.isEmpty
        });
        const isSameSelectionSnapshot = (left, right) =>
            !!left &&
            !!right &&
            left.isEmpty === right.isEmpty &&
            isSamePositionSnapshot(left.anchor, right.anchor) &&
            isSamePositionSnapshot(left.active, right.active);
        const clearLastCtrlHackDeniedHover = () => {
            lastCtrlHackDeniedHover = null;
        };
        const rememberCtrlHackDeniedHover = (document, position) => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || activeEditor.document !== document) {
                clearLastCtrlHackDeniedHover();
                return;
            }
            lastCtrlHackDeniedHover = {
                editor: activeEditor,
                document,
                documentVersion: document.version,
                hoverPosition: getPositionSnapshot(position),
                selectionSnapshot: cloneSelectionSnapshot(activeEditor.selection),
                timestamp: Date.now()
            };
        };
        const isCtrlHackDeniedHoverStillReusable = state => {
            if (!state) return false;
            if ((Date.now() - state.timestamp) > CTRL_HACK_REOPEN_WINDOW_MS) return false;
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || activeEditor !== state.editor) return false;
            if (activeEditor.document !== state.document) return false;
            if (activeEditor.document.version !== state.documentVersion) return false;
            return isSameSelectionSnapshot(cloneSelectionSnapshot(activeEditor.selection), state.selectionSnapshot);
        };
        const closeCtrlHackHover = () => {
            vscode.commands.executeCommand('editor.action.closeHover').then(
                undefined,
                () => {}
            );
            setTimeout(() => {
                vscode.commands.executeCommand('editor.action.closeHover').then(
                    undefined,
                    () => {}
                );
            }, 30);
        };
        const tryReplayCtrlHackHover = () => {
            const state = lastCtrlHackDeniedHover;
            if (!isCtrlHackDeniedHoverStillReusable(state)) return;
            clearLastCtrlHackDeniedHover();
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || activeEditor !== state.editor) return;
            if (typeof vscode.Position !== 'function' || typeof vscode.Selection !== 'function') {
                vscode.commands.executeCommand('editor.action.showHover').then(
                    undefined,
                    () => {}
                );
                return;
            }

            const currentSelectionSnapshot = cloneSelectionSnapshot(activeEditor.selection);
            const hoverMatchesSelection = isSamePositionSnapshot(state.hoverPosition, currentSelectionSnapshot.active);
            if (hoverMatchesSelection) {
                vscode.commands.executeCommand('editor.action.showHover').then(
                    undefined,
                    () => {}
                );
                return;
            }

            const hoverPos = new vscode.Position(state.hoverPosition.line, state.hoverPosition.character);
            const originalSelections = Array.isArray(activeEditor.selections) && activeEditor.selections.length
                ? activeEditor.selections.slice()
                : [activeEditor.selection];
            const temporarySelection = new vscode.Selection(hoverPos, hoverPos);
            activeEditor.selection = temporarySelection;
            activeEditor.selections = [temporarySelection];
            vscode.commands.executeCommand('editor.action.showHover').then(
                () => {
                    setTimeout(() => {
                        const editorNow = vscode.window.activeTextEditor;
                        if (!editorNow || editorNow !== activeEditor || editorNow.document !== state.document) return;
                        editorNow.selections = originalSelections;
                        editorNow.selection = originalSelections[0];
                    }, CTRL_HACK_SELECTION_RESTORE_DELAY_MS);
                },
                () => {
                    const editorNow = vscode.window.activeTextEditor;
                    if (!editorNow || editorNow !== activeEditor || editorNow.document !== state.document) return;
                    editorNow.selections = originalSelections;
                    editorNow.selection = originalSelections[0];
                }
            );
        };

        const stopCtrlHackTracker = () => {
            ctrlHackTracker?.stop();
            ctrlHackTracker = null;
            clearLastCtrlHackDeniedHover();
        };
        const ensureCtrlHackTracker = () => {
            if (process.platform !== 'win32') return false;
            if (!ctrlHackTracker) {
                ctrlHackTracker = createWindowsCtrlHackTracker(pressed => {
                    if (pressed) {
                        tryReplayCtrlHackHover();
                        return;
                    }
                    if (!pressed) {
                        clearLastCtrlHackDeniedHover();
                        closeCtrlHackHover();
                    }
                });
            }
            const wasRunning = ctrlHackTracker.isRunning();
            return wasRunning || ctrlHackTracker.start();
        };
        const getEffectiveHoverMode = () => {
            const configuredMode = typeof getHoverMode === 'function' ? getHoverMode() : 'normal';
            if (configuredMode !== 'ctrl-hack') return configuredMode;
            if (process.platform !== 'win32') return 'normal';
            if (ensureCtrlHackTracker()) return 'ctrl-hack';
            return 'normal';
        };
        const refreshHoverModeRuntime = () => {
            refreshExtensionSettings?.();
            const mode = typeof getHoverMode === 'function' ? getHoverMode() : 'normal';
            if (mode === 'ctrl-hack' && process.platform === 'win32') {
                ensureCtrlHackTracker();
            } else {
                stopCtrlHackTracker();
            }
        };

        const hoverProvider = vscode.languages.registerHoverProvider('amxxpawn', {
            provideHover(document, position) {
                try {
                    const hoverMode = getEffectiveHoverMode();
                    const shouldProvideHover =
                        hoverMode !== 'disabled' &&
                        (hoverMode !== 'ctrl-hack' || ctrlHackTracker?.isPressed());
                    if (hoverMode === 'ctrl-hack' && !shouldProvideHover) {
                        rememberCtrlHackDeniedHover(document, position);
                    } else {
                        clearLastCtrlHackDeniedHover();
                    }
                    return shouldProvideHover
                        ? buildHoverAtPosition(document, position)
                        : null;
                } catch (err) {
                    console.error('provideHover:', err);
                    return null;
                }
            }
        });
        context.subscriptions.push(hoverProvider);
        if (typeof vscode.workspace?.onDidChangeConfiguration === 'function') {
            context.subscriptions.push(
                vscode.workspace.onDidChangeConfiguration(event => {
                    if (!affectsAnyConfiguration?.(event, HOVER_RELEVANT_CONFIG_KEYS || [])) return;
                    refreshHoverModeRuntime();
                    vscode.commands.executeCommand('editor.action.closeHover').then(
                        undefined,
                        () => {}
                    );
                })
            );
        }
        context.subscriptions.push({
            dispose() {
                stopCtrlHackTracker();
            }
        });
        refreshHoverModeRuntime();
        return hoverProvider;
    }

    return {
        register
    };
}

module.exports = { createHoverFeature };
