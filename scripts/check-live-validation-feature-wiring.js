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
    fs.writeFileSync(path.join(tempIncludeRoot, 'callback_parent.inc'), [
        'forward client_disconnected(id, bool:drop, message[], maxlen)',
        ''
    ].join('\n'));
    fs.writeFileSync(path.join(tempIncludeRoot, 'alias_func.inc'), [
        'enum DataType',
        '{',
        '    ced_int',
        '}',
        'native ced_get(iEntity, DataType:type, any:defaultValue)',
        '#define get_ced ced_get',
        ''
    ].join('\n'));
    fs.writeFileSync(path.join(tempIncludeRoot, 'hard_inc.inc'), '#define HARD_INC_SYMBOL 1\n');
    fs.writeFileSync(path.join(tempIncludeRoot, 'hard_p.p'), '#define HARD_P_SYMBOL 1\n');
    fs.writeFileSync(path.join(tempIncludeRoot, 'hard_i.i'), '#define HARD_I_SYMBOL 1\n');
    fs.writeFileSync(path.join(tempIncludeRoot, 'hard_pawn.pawn'), '#define HARD_PAWN_SYMBOL 1\n');
    fs.writeFileSync(path.join(tempIncludeRoot, 'hard_order.inc'), '#define HARD_ORDER_INC 1\n');
    fs.writeFileSync(path.join(tempIncludeRoot, 'hard_order.p'), '#define HARD_ORDER_P 1\n');
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
        buildSig({ type: 'variable', name: 'g_explicit', modifiers: ['new'], dims: '[2][3]', value: '{ { 1, 2, 3 }, { 4, 5, 6 } }' }) === 'new g_explicit[2][3] initializer_size(2, 3)',
        'hover signature should render initializer usage size separately when every variable dimension is explicit'
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
    const createLiveValidationWithConfig = configurationOverrides => {
        const configuredVscode = createMockVscode(workspaceRoot, {
            projectLocalIncludePaths: [tempIncludeRoot],
            ...configurationOverrides
        });
        const configuredSettingsService = createSettingsService(configuredVscode);
        const configuredState = createActivationState();
        const configuredContext = {
            subscriptions: [],
            globalStorageUri: {
                fsPath: path.join(tempRoot, `storage-${configurationOverrides?.callbackSignatureMode || 'strict'}`)
            }
        };
        const configuredCoreRuntime = buildCoreActivationRuntime({
            vscode: configuredVscode,
            fs,
            path,
            context: configuredContext,
            t,
            settingsService: configuredSettingsService,
            state: configuredState
        });
        return {
            vscode: configuredVscode,
            coreRuntime: configuredCoreRuntime,
            liveValidation: buildLiveValidationFeature(
                {
                    vscode: configuredVscode,
                    fs,
                    path,
                    context: configuredContext,
                    coreRuntime: configuredCoreRuntime,
                    liveValidationOutputChannel: { appendLine() {} }
                },
                {
                    themeRecommendationFeature: { prompt() {} }
                }
            )
        };
    };

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

    const ternaryBoolCallDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-ternary-bool-call.sma'),
        `
native bool:is_on_ground(iPlayer, Float:vOrigin[3])

public test(iPlayer)
{
    static bool:bOnGround
    static bool:bCD
    static bool:bOther
    static Float:vOrigin[3]
    bOnGround = bCD ? true : is_on_ground(iPlayer, vOrigin)
    bOnGround = bCD ? bOther : is_on_ground(iPlayer, vOrigin)
}
`.trimStart()
    );
    const ternaryBoolDiagnostics = liveValidation.collectLiveValidationDiagnostics(ternaryBoolCallDocument);
    const boolTrueTagMismatch = t('validation.tagMismatch', { expected: 'bool', actual: 'true' });
    const boolOtherTagMismatch = t('validation.tagMismatch', { expected: 'bool', actual: 'bOther' });
    assert(
        !ternaryBoolDiagnostics.some(diagnostic =>
            diagnostic.message === boolTrueTagMismatch ||
            diagnostic.message === boolOtherTagMismatch
        ),
        `ternary false-branch call should not treat the ternary separator as a call result tag override, got: ${ternaryBoolDiagnostics.map(diagnostic => `${diagnostic.message} @ ${ternaryBoolCallDocument.getText(diagnostic.range)}`).join(' | ')}`
    );

    const callResultTagOverrideDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-call-result-tag-override.sma'),
        `
native bool:is_on_ground(iPlayer, Float:vOrigin[3])

public test(iPlayer)
{
    static bool:bOnGround
    static Float:vOrigin[3]
    bOnGround = Float:is_on_ground(iPlayer, vOrigin)
}
`.trimStart()
    );
    const callResultTagOverrideDiagnostics = liveValidation.collectLiveValidationDiagnostics(callResultTagOverrideDocument);
    const boolFloatTagMismatch = t('validation.tagMismatch', { expected: 'bool', actual: 'Float' });
    assert(
        callResultTagOverrideDiagnostics.some(diagnostic => diagnostic.message === boolFloatTagMismatch),
        `real call result tag override should still be validated, got: ${callResultTagOverrideDiagnostics.map(diagnostic => `${diagnostic.message} @ ${callResultTagOverrideDocument.getText(diagnostic.range)}`).join(' | ')}`
    );

    const vectorMacroDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-vector-macro-declaration.sma'),
        `
#define Vector3(%0) Float: %0[3]
native server_print(const fmt[], any:...)

new Vector3(gOrigin)

public main()
{
    new Vector3(vOrigin)
    server_print("%f %f", gOrigin[0], vOrigin[0])
}
`.trimStart()
    );
    const vectorMacroContext = coreRuntime.sharedRuntime.getPawnDocumentContext(vectorMacroDocument, 9);
    const vectorMacroGlobal = vectorMacroContext.parsedDecls.globals.find(decl => decl.name === 'gOrigin');
    const vectorMacroLocal = vectorMacroContext.parsedDecls.locals.find(decl => decl.name === 'vOrigin');
    assert(
        vectorMacroGlobal?.typeTag === 'Float' && vectorMacroGlobal?.dims === '[3]',
        `global Vector3 macro declaration should parse as Float array, got: ${JSON.stringify(vectorMacroGlobal)}`
    );
    assert(
        vectorMacroLocal?.typeTag === 'Float' && vectorMacroLocal?.dims === '[3]',
        `local Vector3 macro declaration should parse as Float array, got: ${JSON.stringify(vectorMacroLocal)}`
    );
    const vectorMacroDiagnostics = liveValidation.collectLiveValidationDiagnostics(vectorMacroDocument);
    assert(
        !vectorMacroDiagnostics.some(diagnostic =>
            /unknown symbol: (?:gOrigin|vOrigin)|unexpected token: \)/.test(diagnostic.message)
        ),
        `Vector3 macro declaration should not produce unknown symbol or trailing-paren diagnostics, got: ${vectorMacroDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );

    const aliasFunctionDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-function-alias.sma'),
        `
#include <alias_func>

public test()
{
    return get_ced(1, ced_int)
}
`.trimStart()
    );
    const aliasFunctionContext = coreRuntime.sharedRuntime.getPawnDocumentContext(aliasFunctionDocument);
    const aliasFunctionMatch = aliasFunctionContext.lookup.getPreferredFunctionMatch('get_ced');
    assert(
        aliasFunctionMatch?.data?.name === 'ced_get' &&
            aliasFunctionMatch.data.hoverDisplayName === 'get_ced' &&
            aliasFunctionMatch.data.aliasDefineDecl?.name === 'get_ced',
        `function alias should resolve to target signature with alias display name, got: ${JSON.stringify(aliasFunctionMatch?.data)}`
    );
    const aliasFunctionSignature = buildSig(aliasFunctionMatch.data);
    assert(
        aliasFunctionSignature.includes('get_ced(') &&
            aliasFunctionSignature.includes('DataType:type') &&
            aliasFunctionSignature.includes('any:defaultValue'),
        `function alias signature should render target args under alias name, got: ${aliasFunctionSignature}`
    );
    const aliasFunctionDiagnostics = liveValidation.collectLiveValidationDiagnostics(aliasFunctionDocument);
    const missingAliasDefault = t('validation.missingArgument');
    assert(
        aliasFunctionDiagnostics.some(diagnostic => diagnostic.message === missingAliasDefault),
        `function alias calls should validate against the target signature, got: ${aliasFunctionDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    assert(
        !aliasFunctionDiagnostics.some(diagnostic => /unknown symbol: get_ced/.test(diagnostic.message)),
        `function alias name should not be reported as unknown, got: ${aliasFunctionDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );

    const trailingCommaDeclarationDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-trailing-comma-declaration.sma'),
        `
new HookChain:g_HookChainPMMove,

new g_iPlMarker[4][33]

public main()
{
    return sizeof(g_iPlMarker)
}
`.trimStart()
    );
    const trailingCommaContext = coreRuntime.sharedRuntime.getPawnDocumentContext(trailingCommaDeclarationDocument);
    const trailingCommaGlobals = trailingCommaContext.parsedDecls.globals;
    assert(
        trailingCommaGlobals.some(decl => decl.name === 'g_HookChainPMMove'),
        'trailing comma before a new declaration should keep the previous declaration parseable'
    );
    assert(
        trailingCommaGlobals.some(decl => decl.name === 'g_iPlMarker'),
        'trailing comma before a new declaration should not swallow the next declaration'
    );
    const trailingCommaDiagnostics = liveValidation.collectLiveValidationDiagnostics(trailingCommaDeclarationDocument);
    const unexpectedComma = t('validation.unexpectedToken', { token: ',' });
    const trailingCommaDiagnostic = trailingCommaDiagnostics.find(diagnostic => diagnostic.message === unexpectedComma);
    assert(
        trailingCommaDiagnostic && trailingCommaDeclarationDocument.getText(trailingCommaDiagnostic.range) === ',',
        `trailing declaration comma should report the comma itself, got: ${trailingCommaDiagnostics.map(diagnostic => `${diagnostic.message} @ ${trailingCommaDeclarationDocument.getText(diagnostic.range)}`).join(' | ')}`
    );
    assert(
        !trailingCommaDiagnostics.some(diagnostic =>
            diagnostic.message === unexpectedComma &&
            trailingCommaDeclarationDocument.getText(diagnostic.range) === 'new'
        ),
        'trailing declaration comma should not cascade into an unexpected token on the next declaration'
    );

    const missingFunctionBodyDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-missing-function-body.sma'),
        `
func()

public plugin_natives()
{
}
`.trimStart()
    );
    const missingFunctionBodyContext = coreRuntime.sharedRuntime.getPawnDocumentContext(missingFunctionBodyDocument);
    const danglingFunction = missingFunctionBodyContext.parsedDecls.functions.find(decl => decl.name === 'func');
    const pluginNativesFunction = missingFunctionBodyContext.parsedDecls.functions.find(decl => decl.name === 'plugin_natives');
    assert(
        danglingFunction && !Number.isInteger(danglingFunction.singleStatementBodyLine),
        `dangling function header should not claim the next declaration as a single-statement body, got: ${JSON.stringify(danglingFunction)}`
    );
    assert(
        pluginNativesFunction?.startLine === 2,
        `function after a dangling header should remain independently parseable, got: ${JSON.stringify(pluginNativesFunction)}`
    );
    const missingFunctionBodyDiagnostics = liveValidation.collectLiveValidationDiagnostics(missingFunctionBodyDocument);
    const functionBodyExpected = t('validation.functionBodyExpected');
    const missingFunctionBodyDiagnostic = missingFunctionBodyDiagnostics.find(diagnostic =>
        diagnostic.message === functionBodyExpected
    );
    assert(
        missingFunctionBodyDiagnostic && missingFunctionBodyDocument.getText(missingFunctionBodyDiagnostic.range) === 'func',
        `missing function body should be reported on the dangling function name, got: ${missingFunctionBodyDiagnostics.map(diagnostic => `${diagnostic.message} @ ${missingFunctionBodyDocument.getText(diagnostic.range)}`).join(' | ')}`
    );
    assert(
        !missingFunctionBodyDiagnostics.some(diagnostic =>
            diagnostic.message === functionBodyExpected &&
            missingFunctionBodyDocument.getText(diagnostic.range) === 'plugin_natives'
        ),
        'missing function body should not cascade onto the following public declaration'
    );

    const inlineEmptyFunctionBodyDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-inline-empty-function-body.sma'),
        `
public query_handler_clear(failstate, Handle:query, error[], errnum, data[], size, Float:queuetime){}
`.trimStart()
    );
    const inlineEmptyFunctionBodyDiagnostics = liveValidation.collectLiveValidationDiagnostics(inlineEmptyFunctionBodyDocument);
    assert(
        !inlineEmptyFunctionBodyDiagnostics.some(diagnostic => diagnostic.message === functionBodyExpected),
        `inline empty function body should count as a real body, got: ${inlineEmptyFunctionBodyDiagnostics.map(diagnostic => `${diagnostic.message} @ ${inlineEmptyFunctionBodyDocument.getText(diagnostic.range)}`).join(' | ')}`
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

    const hardIncludeDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-hard-compiler-include-extensions.sma'),
        `
#include <hard_inc>
#include <hard_p>
#include <hard_i>
#include <hard_pawn>
#include <hard_order>

public main()
{
    return HARD_INC_SYMBOL + HARD_P_SYMBOL + HARD_I_SYMBOL + HARD_PAWN_SYMBOL + HARD_ORDER_INC;
}
`.trimStart()
    );
    const hardIncludeContext = coreRuntime.sharedRuntime.getPawnDocumentContext(hardIncludeDocument);
    const hardIncludeDefines = new Set(hardIncludeContext.incDecls
        .filter(decl => decl.type === 'define')
        .map(decl => decl.name));
    for (const name of ['HARD_INC_SYMBOL', 'HARD_P_SYMBOL', 'HARD_I_SYMBOL', 'HARD_PAWN_SYMBOL', 'HARD_ORDER_INC']) {
        assert(hardIncludeDefines.has(name), `extensionless include should resolve compiler include extension for ${name}`);
    }
    assert(
        !hardIncludeDefines.has('HARD_ORDER_P'),
        'extensionless include should prefer .inc before .p when both files exist'
    );

    const hardIncludeOnlyHarness = createLiveValidationWithConfig({ includeFileExtensions: [] });
    const hardIncludeOnlyContext = hardIncludeOnlyHarness.coreRuntime.sharedRuntime.getPawnDocumentContext(hardIncludeDocument);
    const hardIncludeOnlyDefines = new Set(hardIncludeOnlyContext.incDecls
        .filter(decl => decl.type === 'define')
        .map(decl => decl.name));
    assert(
        hardIncludeOnlyDefines.has('HARD_P_SYMBOL') &&
            hardIncludeOnlyDefines.has('HARD_I_SYMBOL') &&
            hardIncludeOnlyDefines.has('HARD_PAWN_SYMBOL'),
        'compiler include extensions should remain enabled even when custom includeFileExtensions is empty'
    );

    const callbackDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-callback-forward-parent.sma'),
        `
#include <callback_parent>

public client_disconnected(id)
{
}
`.trimStart()
    );
    const strictCallbackDiagnostics = liveValidation.collectLiveValidationDiagnostics(callbackDocument);
    const missingParameterDeclaration = t('validation.missingParameterDeclaration');
    assert(
        strictCallbackDiagnostics.some(diagnostic => diagnostic.message === missingParameterDeclaration),
        `strict callback signature mode should report missing trailing forward parameters, got: ${strictCallbackDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );

    const compilerLikeHarness = createLiveValidationWithConfig({ callbackSignatureMode: 'compiler-like' });
    const compilerLikeCallbackDiagnostics = compilerLikeHarness.liveValidation.collectLiveValidationDiagnostics(callbackDocument);
    assert(
        !compilerLikeCallbackDiagnostics.some(diagnostic => diagnostic.message === missingParameterDeclaration),
        `compiler-like callback signature mode should allow public callbacks with omitted trailing forward parameters, got: ${compilerLikeCallbackDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );

    const localForwardDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-local-callback-forward-parent.sma'),
        `
forward sw_local_callback(id, bool:drop, message[], maxlen)

public sw_local_callback(id)
{
}
`.trimStart()
    );
    const strictLocalForwardDiagnostics = liveValidation.collectLiveValidationDiagnostics(localForwardDocument);
    const functionHeadingDiffers = t('validation.functionHeadingDiffersFromPrototype');
    assert(
        strictLocalForwardDiagnostics.some(diagnostic => diagnostic.message === functionHeadingDiffers),
        `strict callback signature mode should report local forward/public prototype mismatch, got: ${strictLocalForwardDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    const compilerLikeLocalForwardDiagnostics = compilerLikeHarness.liveValidation.collectLiveValidationDiagnostics(localForwardDocument);
    assert(
        !compilerLikeLocalForwardDiagnostics.some(diagnostic => diagnostic.message === functionHeadingDiffers),
        `compiler-like callback signature mode should allow public callbacks with omitted local forward parameters, got: ${compilerLikeLocalForwardDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );

    const localNativeDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-local-native-public-mismatch.sma'),
        `
native sw_native_parent(id, bool:drop)

public sw_native_parent(id)
{
}
`.trimStart()
    );
    const compilerLikeNativeDiagnostics = compilerLikeHarness.liveValidation.collectLiveValidationDiagnostics(localNativeDocument);
    assert(
        compilerLikeNativeDiagnostics.some(diagnostic => diagnostic.message === functionHeadingDiffers),
        `compiler-like callback signature mode should not suppress native/public prototype mismatch, got: ${compilerLikeNativeDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });

    console.log('live-validation:feature-wiring pass');
}

main();
