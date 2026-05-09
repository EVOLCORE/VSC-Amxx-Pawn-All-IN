const fs = require('fs');
const path = require('path');

const { createRuntimeLocalization } = require('../services/localization');
const { createSettingsService } = require('../services/settings');
const { createActivationState } = require('../bootstrap/state');
const { buildCoreActivationRuntime } = require('../bootstrap/build-core-runtime');
const { buildLiveValidationFeature } = require('../bootstrap/feature-wiring/live-validation');
const { MockDocument, createMockVscode } = require('./bench-live-validation');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function main() {
    const workspaceRoot = process.cwd();
    const vscode = createMockVscode(workspaceRoot);
    const { t } = createRuntimeLocalization(vscode);
    const settingsService = createSettingsService(vscode);
    const state = createActivationState();
    const context = {
        subscriptions: [],
        globalStorageUri: {
            fsPath: path.join(workspaceRoot, '.tmp-live-validation-feature-wiring')
        }
    };
    const coreRuntime = buildCoreActivationRuntime({
        vscode,
        fs,
        path,
        context,
        t,
        settingsService,
        state
    });

    const liveValidation = buildLiveValidationFeature(
        {
            vscode,
            fs,
            path,
            context,
            coreRuntime,
            liveValidationOutputChannel: { appendLine() {} }
        },
        {
            themeRecommendationFeature: { prompt() {} }
        }
    );

    const document = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-define.sma'),
        `
#define TEST_DEFINE 1
#define TEST_DEFINE 2
#if defined TEST_DEFINE
#define TEST_CONDITION 1
#else
#define TEST_CONDITION 0
#endif

public plugin_init()
{
    new value = TEST_DEFINE + TEST_CONDITION;
}
`.trimStart()
    );
    vscode.workspace.textDocuments = [document];

    const diagnostics = liveValidation.collectLiveValidationDiagnostics(document);
    assert(Array.isArray(diagnostics), 'live validation feature wiring should return diagnostics array');

    const sizeofDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-sizeof-inferred-array.sma'),
        `
new const GEN_FILES[][] =
{
    "sound/sw/i/lv/1.wav",
    "sound/sw/i/a/1.wav" "sound/sw/i/ds/1.wav",
    "sound/sw/i/pr/1.mp3"
};

public main()
{
    new sizes[sizeof(GEN_FILES)];
    new size = sizeof(GEN_FILES);
    return size + sizeof(sizes);
}
`.trimStart()
    );
    const sizeofDiagnostics = liveValidation.collectLiveValidationDiagnostics(sizeofDocument);
    const indeterminateSizeof = t('validation.indeterminateArraySizeInSizeof', { name: 'GEN_FILES' });
    const unexpectedInitializerString = t('validation.unexpectedStringLiteralInInitializer');
    assert(
        !sizeofDiagnostics.some(diagnostic => diagnostic.message === indeterminateSizeof),
        'sizeof should accept inferred first dimension from concatenated string array initializer'
    );
    assert(
        sizeofDiagnostics.some(diagnostic => diagnostic.message === unexpectedInitializerString),
        `concatenated initializer strings should fail as an unexpected initializer string, got: ${sizeofDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    const missingCommaDiagnostic = sizeofDiagnostics.find(diagnostic => diagnostic.message === unexpectedInitializerString);
    assert(
        sizeofDocument.getText(missingCommaDiagnostic.range) === '"sound/sw/i/ds/1.wav"',
        `missing comma warning should point at the second concatenated string, got: ${sizeofDocument.getText(missingCommaDiagnostic.range)}`
    );
    assert(
        missingCommaDiagnostic.severity === vscode.DiagnosticSeverity.Error,
        'missing comma between initializer strings should be an error'
    );

    const deepSizeofDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-sizeof-deep-inferred-array.sma'),
        `
new const DEEP_FILES[][][] =
{
    { "a.wav", "bb.wav" },
    { "ccc.wav" }
};

public deep()
{
    new outer[sizeof(DEEP_FILES)];
    new middle[sizeof(DEEP_FILES[])];
    new inner[sizeof(DEEP_FILES[][])];
    return sizeof(outer) + sizeof(middle) + sizeof(inner);
}
`.trimStart()
    );
    const deepSizeofDiagnostics = liveValidation.collectLiveValidationDiagnostics(deepSizeofDocument);
    assert(
        !deepSizeofDiagnostics.some(diagnostic => diagnostic.message.includes('sizeof')),
        `deep inferred sizeof should stay clean, got: ${deepSizeofDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );

    console.log('live-validation:feature-wiring pass');
}

main();
