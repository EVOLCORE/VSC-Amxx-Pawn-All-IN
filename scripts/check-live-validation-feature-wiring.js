const fs = require('fs');
const os = require('os');
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
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amxx-live-validation-feature-'));
    const tempIncludeRoot = path.join(tempRoot, 'include');
    fs.mkdirSync(tempIncludeRoot, { recursive: true });
    fs.writeFileSync(path.join(tempIncludeRoot, 'enum_size.inc'), '#define MAX_AUTHID_LENGTH 35\n');
    fs.writeFileSync(path.join(tempIncludeRoot, 'enum_shared.inc'), [
        'enum _:ACTION_DATA',
        '{',
        '    AD_CURACTION,',
        '    AD_FLAGS',
        '}',
        ''
    ].join('\n'));
    fs.writeFileSync(path.join(tempIncludeRoot, 'enum_root.inc'), '#include <enum_shared>\n');
    const vscode = createMockVscode(workspaceRoot, {
        projectLocalIncludePaths: [tempIncludeRoot]
    });
    const { t } = createRuntimeLocalization(vscode);
    const settingsService = createSettingsService(vscode);
    const state = createActivationState();
    const context = {
        subscriptions: [],
        globalStorageUri: {
            fsPath: path.join(tempRoot, 'storage')
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
    const { buildSig, getVariableInitializerUsageText } = coreRuntime.sharedRuntime;
    assert(
        buildSig({ type: 'variable', name: 'g_files', modifiers: ['new', 'const'], dims: '[][]', value: '{ "a.wav", "long_name.wav" }' }) === 'new const g_files[][] size(2, 14)',
        'hover signature should render inferred sizes for initialized variable declarations with blank dimensions'
    );
    assert(
        buildSig({ type: 'variable', name: 'g_explicit', modifiers: ['new'], dims: '[2][3]', value: '{ { 1, 2, 3 }, { 4, 5, 6 } }' }) === 'new g_explicit[2][3]',
        'hover signature should not render inferred sizes when every variable dimension is explicit'
    );
    assert(
        getVariableInitializerUsageText({ type: 'variable', name: 'g_explicit_files', modifiers: ['new'], dims: '[4][64]', value: '{ "a.wav", "long_name.wav" }' }) === '[2][14]',
        'hover info should expose actual initializer shape for explicitly sized arrays'
    );
    assert(
        getVariableInitializerUsageText({ type: 'variable', name: 'g_partial_files', modifiers: ['new'], dims: '[4][]', value: '{ "a.wav", "long_name.wav" }' }) === '[2][14]',
        'hover info should expose actual initializer shape separately from partially inferred declaration shape'
    );
    assert(
        getVariableInitializerUsageText({ type: 'variable', name: 'g_files', modifiers: ['new'], dims: '[][]', value: '{ "a.wav", "long_name.wav" }' }) === '',
        'hover info should not duplicate signature size when every dimension is inferred'
    );
    assert(
        buildSig({ type: 'variable', name: 'arg_values', modifiers: ['const'], dims: '[]', value: '{ 1, 2 }', isArg: true }) === 'const arg_values[]',
        'hover signature should not render inferred sizes for function argument defaults'
    );

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

    const indexedScalarAssignmentDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-indexed-scalar-array-assignment.sma'),
        `
new Float:vCenter[3];
new Float:vPoint[3];

public main()
{
    vPoint = vCenter;
    vPoint[0] = vCenter;
    vPoint[1] = vCenter[1];
}
`.trimStart()
    );
    const indexedScalarAssignmentDiagnostics = liveValidation.collectLiveValidationDiagnostics(indexedScalarAssignmentDocument);
    const arrayMustBeIndexed = t('validation.arrayMustBeIndexed', { name: 'vCenter' });
    const indexedScalarAssignmentIssues = indexedScalarAssignmentDiagnostics.filter(
        diagnostic => diagnostic.message === arrayMustBeIndexed
    );
    assert(
        indexedScalarAssignmentIssues.length === 1,
        `indexed scalar assigned from array should report one array-indexing error, got: ${indexedScalarAssignmentDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    assert(
        indexedScalarAssignmentDocument.getText(indexedScalarAssignmentIssues[0].range) === 'vCenter',
        `indexed scalar array-assignment warning should point at RHS vCenter, got: ${indexedScalarAssignmentDocument.getText(indexedScalarAssignmentIssues[0].range)}`
    );

    const includeSizedEnumDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-include-sized-enum.sma'),
        `
#include <enum_size>

enum _:STRUCT_PLAYER_DATA
{
    PD_CURULT,
    PD_AUTHID[MAX_AUTHID_LENGTH],
    PD_ACCID
}
`.trimStart()
    );
    const includeSizedEnumContext = coreRuntime.sharedRuntime.getPawnDocumentContext(includeSizedEnumDocument);
    const includeSizedEnumDecls = includeSizedEnumContext.parsedDecls.globals;
    const playerDataEnum = includeSizedEnumDecls.find(decl => decl.type === 'enum' && decl.name === 'STRUCT_PLAYER_DATA');
    const authIdMember = includeSizedEnumDecls.find(decl => decl.type === 'enum-item' && decl.name === 'PD_AUTHID');
    const accountIdMember = includeSizedEnumDecls.find(decl => decl.type === 'enum-item' && decl.name === 'PD_ACCID');
    assert(playerDataEnum?.value === '37', `include-defined enum field size should set enum capacity to 37, got: ${playerDataEnum?.value}`);
    assert(authIdMember?.value === '1', `include-defined enum array field should start at 1, got: ${authIdMember?.value}`);
    assert(accountIdMember?.value === '36', `field after include-defined enum array should start at 36, got: ${accountIdMember?.value}`);

    const lateIncludeEnumDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-late-include-sized-enum.sma'),
        `
enum _:STRUCT_PLAYER_DATA
{
    PD_CURULT,
    PD_AUTHID[MAX_AUTHID_LENGTH],
    PD_ACCID
}

#include <enum_size>
`.trimStart()
    );
    const lateIncludeEnumContext = coreRuntime.sharedRuntime.getPawnDocumentContext(lateIncludeEnumDocument);
    const lateIncludeEnumDecls = lateIncludeEnumContext.parsedDecls.globals;
    const lateIncludePlayerDataEnum = lateIncludeEnumDecls.find(decl => decl.type === 'enum' && decl.name === 'STRUCT_PLAYER_DATA');
    const lateIncludeAccountIdMember = lateIncludeEnumDecls.find(decl => decl.type === 'enum-item' && decl.name === 'PD_ACCID');
    assert(lateIncludePlayerDataEnum?.value === '3', `late include should not affect earlier enum capacity, got: ${lateIncludePlayerDataEnum?.value}`);
    assert(lateIncludeAccountIdMember?.value === '2', `late include should not size an earlier enum array field, got: ${lateIncludeAccountIdMember?.value}`);

    const duplicateIncludeEnumDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-duplicate-include-enum.sma'),
        `
#include <enum_root>
#include <enum_shared>

new eActionData[ACTION_DATA]
`.trimStart()
    );
    const duplicateIncludeEnumContext = coreRuntime.sharedRuntime.getPawnDocumentContext(duplicateIncludeEnumDocument);
    const duplicateIncludeEnumDecls = duplicateIncludeEnumContext.incDecls;
    const duplicateActionEnums = duplicateIncludeEnumDecls.filter(decl => decl.type === 'enum' && decl.name === 'ACTION_DATA');
    const duplicateActionItems = duplicateIncludeEnumDecls.filter(decl => decl.type === 'enum-item' && decl.enumName === '_:ACTION_DATA');
    assert(duplicateActionEnums.length === 1, `duplicate include graph should expose ACTION_DATA enum once, got: ${duplicateActionEnums.length}`);
    assert(duplicateActionItems.length === 2, `duplicate include graph should expose ACTION_DATA members once, got: ${duplicateActionItems.length}`);

    fs.rmSync(tempRoot, { recursive: true, force: true });

    console.log('live-validation:feature-wiring pass');
}

main();
