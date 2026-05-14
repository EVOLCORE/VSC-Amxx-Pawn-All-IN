const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { registerCompilerIntegration } = require('../services/compiler');
const { createDebugOutputChannel } = require('../services/debug-output');
const { createRuntimeLocalization } = require('../services/localization');
const { createSettingsService } = require('../services/settings');
const { buildLazyActivationRuntime } = require('./build-lazy-runtime');
const { createActivationState } = require('./state');

function activate(context) {
    const { t } = createRuntimeLocalization(vscode);
    const state = createActivationState();

    registerCompilerIntegration(context);

    const settingsService = createSettingsService(vscode);
    settingsService.refresh();
    const liveValidationCollection = vscode.languages.createDiagnosticCollection('amxxPawnAllInLiveValidation');
    const liveValidationOutputChannel = vscode.window.createOutputChannel('AMXX Pawn All-In Live Validation');
    const liveValidationDebugOutputChannel = createDebugOutputChannel(liveValidationOutputChannel, settingsService);
    context.subscriptions.push(liveValidationCollection, liveValidationOutputChannel);

    const {
        editorLifecycleFeature,
        persistentHoverFeature,
        hoverFeature,
        completionFeature,
        navigationFeature,
        renameFeature
    } = buildLazyActivationRuntime({
        vscode,
        fs,
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
}

exports.activate = activate;
