const { spawn } = require('child_process');
const path = require('path');
const { unrefTimer } = require('../../core/utils/timers');
const {
    DEFAULT_HOVER_MODIFIER_HACK_HOLD_DELAY_MS,
    createModifierHoldGate,
    getHoverModifierHackKey,
    isHoverModifierHackMode
} = require('../../core/hover-modes');

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
    const MODIFIER_HACK_REOPEN_WINDOW_MS = 700;
    const MODIFIER_HACK_SELECTION_RESTORE_DELAY_MS = 0;
    const MODIFIER_HACK_HOLD_DELAY_MS = DEFAULT_HOVER_MODIFIER_HACK_HOLD_DELAY_MS;
    const MODIFIER_HACK_RESTART_MIN_DELAY_MS = 800;
    const MODIFIER_HACK_RESTART_MAX_DELAY_MS = 8000;

    function createWindowsModifierHackTracker(mode, onStateChange) {
        const keySpec = getHoverModifierHackKey(mode) || getHoverModifierHackKey('ctrl-hack');
        if (process.platform !== 'win32') {
            return {
                start: () => false,
                stop: () => {},
                isRunning: () => false,
                isPressed: () => false
            };
        }

        let trackerProcess = null;
        let stdoutBuffer = '';
        let restartTimer = null;
        let restartDelayMs = MODIFIER_HACK_RESTART_MIN_DELAY_MS;
        let disposed = false;
        let processExitHandler = null;
        const modifierHoldGate = createModifierHoldGate({
            holdDelayMs: MODIFIER_HACK_HOLD_DELAY_MS,
            keepTimer: unrefTimer,
            onActiveChange: active => onStateChange?.(active)
        });
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

        const attachProcessExitHandler = () => {
            if (processExitHandler) return;
            processExitHandler = () => {
                try {
                    trackerProcess?.kill?.();
                } catch {
                    // Process is already exiting; best-effort child cleanup only.
                }
            };
            process.once('exit', processExitHandler);
        };

        const detachProcessExitHandler = () => {
            if (!processExitHandler) return;
            if (typeof process.off === 'function') {
                process.off('exit', processExitHandler);
            } else {
                process.removeListener('exit', processExitHandler);
            }
            processExitHandler = null;
        };

        const setPhysicalPressed = nextState => {
            modifierHoldGate.setPhysicalPressed(!!nextState);
        };

        const stop = () => {
            disposed = true;
            clearRestartTimer();
            detachProcessExitHandler();
            if (trackerProcess) {
                trackerProcess.removeAllListeners();
                trackerProcess.stdout?.removeAllListeners();
                trackerProcess.kill();
                trackerProcess = null;
            }
            restartDelayMs = MODIFIER_HACK_RESTART_MIN_DELAY_MS;
            modifierHoldGate.dispose();
        };

        const scheduleRestart = () => {
            if (disposed || trackerProcess) return;
            clearRestartTimer();
            const delayMs = restartDelayMs;
            restartDelayMs = Math.min(
                MODIFIER_HACK_RESTART_MAX_DELAY_MS,
                restartDelayMs * 2
            );
            restartTimer = unrefTimer(setTimeout(() => {
                restartTimer = null;
                start();
            }, delayMs));
        };

        const start = () => {
            if (disposed || process.platform !== 'win32') return false;
            if (trackerProcess) return true;

            const parentPid = Number(process.pid) || 0;
            const script = [
                `$parentPid = ${parentPid}`,
                '$parentCheckCounter = 0',
                `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class NativeKeyboardState { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey); }'`,
                '$last = $null',
                'while ($true) {',
                '    $parentCheckCounter = ($parentCheckCounter + 1) % 25',
                '    if ($parentCheckCounter -eq 0 -and -not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }',
                `    $pressed = ([NativeKeyboardState]::GetAsyncKeyState(${keySpec.vKey}) -band 0x8000) -ne 0`,
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
            attachProcessExitHandler();

            trackerProcess.stdout?.setEncoding('utf8');
            trackerProcess.stdout?.on('data', chunk => {
                restartDelayMs = MODIFIER_HACK_RESTART_MIN_DELAY_MS;
                stdoutBuffer += String(chunk || '');
                const lines = stdoutBuffer.split(/\r?\n/);
                stdoutBuffer = lines.pop() || '';
                for (const line of lines) {
                    const value = String(line || '').trim();
                    if (value === '1') setPhysicalPressed(true);
                    else if (value === '0') setPhysicalPressed(false);
                }
            });
            trackerProcess.stderr?.setEncoding('utf8');
            trackerProcess.stderr?.on('data', () => {});
            trackerProcess.on('exit', (code, signal) => {
                trackerProcess = null;
                stdoutBuffer = '';
                setPhysicalPressed(false);
                scheduleRestart();
            });
            trackerProcess.on('error', () => {
                if (trackerProcess) {
                    trackerProcess.removeAllListeners();
                    trackerProcess.stdout?.removeAllListeners();
                    trackerProcess.stderr?.removeAllListeners();
                    trackerProcess = null;
                }
                setPhysicalPressed(false);
                scheduleRestart();
            });
            return true;
        };

        return {
            start,
            stop,
            isRunning: () => !!trackerProcess,
            isPressed: () => modifierHoldGate.isActivePressed(),
            keyLabel: keySpec.label,
            mode
        };
    }

    function register(context) {
        let modifierHackTracker = null;
        let modifierHackTrackerMode = '';
        let lastModifierHackDeniedHover = null;

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
        const clearLastModifierHackDeniedHover = () => {
            lastModifierHackDeniedHover = null;
        };
        const rememberModifierHackDeniedHover = (document, position) => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || activeEditor.document !== document) {
                clearLastModifierHackDeniedHover();
                return;
            }
            lastModifierHackDeniedHover = {
                editor: activeEditor,
                document,
                documentVersion: document.version,
                hoverPosition: getPositionSnapshot(position),
                selectionSnapshot: cloneSelectionSnapshot(activeEditor.selection),
                timestamp: Date.now()
            };
        };
        const isModifierHackDeniedHoverStillReusable = state => {
            if (!state) return false;
            if ((Date.now() - state.timestamp) > MODIFIER_HACK_REOPEN_WINDOW_MS) return false;
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || activeEditor !== state.editor) return false;
            if (activeEditor.document !== state.document) return false;
            if (activeEditor.document.version !== state.documentVersion) return false;
            return isSameSelectionSnapshot(cloneSelectionSnapshot(activeEditor.selection), state.selectionSnapshot);
        };
        const closeModifierHackHover = () => {
            vscode.commands.executeCommand('editor.action.closeHover').then(
                undefined,
                () => {}
            );
            unrefTimer(setTimeout(() => {
                vscode.commands.executeCommand('editor.action.closeHover').then(
                    undefined,
                    () => {}
                );
            }, 30));
        };
        const tryReplayModifierHackHover = () => {
            const state = lastModifierHackDeniedHover;
            if (!isModifierHackDeniedHoverStillReusable(state)) return;
            clearLastModifierHackDeniedHover();
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
                    unrefTimer(setTimeout(() => {
                        const editorNow = vscode.window.activeTextEditor;
                        if (!editorNow || editorNow !== activeEditor || editorNow.document !== state.document) return;
                        editorNow.selections = originalSelections;
                        editorNow.selection = originalSelections[0];
                    }, MODIFIER_HACK_SELECTION_RESTORE_DELAY_MS));
                },
                () => {
                    const editorNow = vscode.window.activeTextEditor;
                    if (!editorNow || editorNow !== activeEditor || editorNow.document !== state.document) return;
                    editorNow.selections = originalSelections;
                    editorNow.selection = originalSelections[0];
                }
            );
        };

        const stopModifierHackTracker = () => {
            modifierHackTracker?.stop();
            modifierHackTracker = null;
            modifierHackTrackerMode = '';
            clearLastModifierHackDeniedHover();
        };
        const ensureModifierHackTracker = mode => {
            if (process.platform !== 'win32') return false;
            if (!isHoverModifierHackMode(mode)) return false;
            if (modifierHackTracker && modifierHackTrackerMode !== mode) {
                stopModifierHackTracker();
            }
            if (!modifierHackTracker) {
                modifierHackTracker = createWindowsModifierHackTracker(mode, pressed => {
                    if (pressed) {
                        tryReplayModifierHackHover();
                        return;
                    }
                    if (!pressed) {
                        clearLastModifierHackDeniedHover();
                        closeModifierHackHover();
                    }
                });
                modifierHackTrackerMode = mode;
            }
            const wasRunning = modifierHackTracker.isRunning();
            return wasRunning || modifierHackTracker.start();
        };
        const getEffectiveHoverMode = () => {
            const configuredMode = getHoverMode();
            if (!isHoverModifierHackMode(configuredMode)) return configuredMode;
            if (process.platform !== 'win32') return 'normal';
            if (ensureModifierHackTracker(configuredMode)) return configuredMode;
            return 'normal';
        };
        const refreshHoverModeRuntime = () => {
            refreshExtensionSettings();
            const mode = getHoverMode();
            if (isHoverModifierHackMode(mode) && process.platform === 'win32') {
                ensureModifierHackTracker(mode);
            } else {
                stopModifierHackTracker();
            }
        };

        const hoverProvider = vscode.languages.registerHoverProvider('amxxpawn', {
            provideHover(document, position) {
                try {
                    const hoverMode = getEffectiveHoverMode();
                    const shouldProvideHover =
                        hoverMode !== 'disabled' &&
                        (!isHoverModifierHackMode(hoverMode) || modifierHackTracker?.isPressed());
                    if (isHoverModifierHackMode(hoverMode) && !shouldProvideHover) {
                        rememberModifierHackDeniedHover(document, position);
                    } else {
                        clearLastModifierHackDeniedHover();
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
                    if (!affectsAnyConfiguration(event, HOVER_RELEVANT_CONFIG_KEYS || [])) return;
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
                stopModifierHackTracker();
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
