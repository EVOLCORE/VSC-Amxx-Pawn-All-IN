const vscode = require('vscode');
const path = require('path');
const { registerLazyCompilerIntegration } = require('../services/compiler-lazy');
const { createDebugOutputChannel } = require('../services/debug-output');
const { createLazyRuntimeTranslator } = require('../services/localization-lazy');
const { createSettingsService } = require('../services/settings');
const { buildLazyActivationRuntime } = require('./build-lazy-runtime');
const { registerActivationGuard } = require('./activation-guard');
const { warnAboutConflictingAmxxPawnExtensions } = require('./extension-conflicts');
const { createActivationState } = require('./state');

function activate(context) {
    registerActivationGuard(context);

    const t = createLazyRuntimeTranslator(vscode);
    const state = createActivationState();

    registerLazyCompilerIntegration(context);

    const settingsService = createSettingsService(vscode);
    settingsService.refresh();
    const liveValidationCollection = vscode.languages.createDiagnosticCollection('amxxPawnAllInLiveValidation');
    const liveValidationOutputChannel = vscode.window.createOutputChannel('AMXX Pawn All-In Live Validation');
    const liveValidationDebugOutputChannel = createDebugOutputChannel(liveValidationOutputChannel, settingsService);
    context.subscriptions.push(liveValidationCollection, liveValidationOutputChannel);
    warnAboutConflictingAmxxPawnExtensions({
        vscode,
        context,
        t,
        outputChannel: liveValidationOutputChannel
    });

    const {
        editorLifecycleFeature,
        persistentHoverFeature,
        hoverFeature,
        completionFeature,
        navigationFeature,
        renameFeature,
        semanticTokensFeature,
        formatStringFeature
    } = buildLazyActivationRuntime({
        vscode,
        path,
        context,
        t,
        settingsService,
        liveValidationCollection,
        liveValidationOutputChannel: liveValidationDebugOutputChannel,
        state
    });

    editorLifecycleFeature.register();
    editorLifecycleFeature.initialize();
    persistentHoverFeature.register(context);
    hoverFeature.register(context);
    completionFeature.register(context);
    navigationFeature.register(context);
    renameFeature.register(context);
    semanticTokensFeature.register(context);
    formatStringFeature.register(context);
}

exports.activate = activate;
