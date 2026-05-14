const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRuntimeLocalization } = require('../services/localization');
const { createSettingsService } = require('../services/settings');
const { createActivationState } = require('../bootstrap/state');
const { buildCoreActivationRuntime } = require('../bootstrap/build-core-runtime');
const { buildLiveValidationFeature } = require('../bootstrap/feature-wiring/live-validation');
const { createHoverSignatureFeature } = require('../features/hover/signature');
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
    fs.writeFileSync(path.join(tempIncludeRoot, 'at_callback_parent.inc'), [
        'forward @client_disconnected(id, bool:drop, message[], maxlen)',
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
    fs.writeFileSync(path.join(tempIncludeRoot, 'underscore_value.inc'), [
        '#define _UNDERSCORE_INCLUDE_GUARD',
        '#define _UNDERSCORE_INCLUDE_VALUE "visible"',
        ''
    ].join('\n'));
    fs.writeFileSync(path.join(tempIncludeRoot, 'bare_child.inc'), '#define BARE_CHILD_SYMBOL 7\n');
    fs.writeFileSync(path.join(tempIncludeRoot, 'bare_root.inc'), '#include bare_child\n#define BARE_ROOT_SYMBOL 8\n');
    fs.writeFileSync(path.join(tempIncludeRoot, 'parent_with_missing_child.inc'), '#include <missing_nested_child>\n#define PARENT_WITH_MISSING_CHILD 9\n');
    const tempProjectRoot = path.join(tempRoot, 'project');
    const tempProjectModuleRoot = path.join(tempProjectRoot, 'Modules');
    fs.mkdirSync(tempProjectModuleRoot, { recursive: true });
    fs.writeFileSync(path.join(tempProjectModuleRoot, 'Feature.inc'), '#include "Modules/FeatureChild"\n#define FEATURE_SYMBOL FEATURE_CHILD_SYMBOL\n');
    fs.writeFileSync(path.join(tempProjectModuleRoot, 'FeatureChild.inc'), '#define FEATURE_CHILD_SYMBOL 10\n');
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
    const {
        buildSig,
        getVariableInitializerUsageText,
        getIncludeNameFromLine,
        parsePreprocessorDirectiveLine,
        getPreprocessorDirectiveIssues,
        splitTopLevel,
        splitTopLevelWithRanges,
        buildCallArgLayout,
        collectCallArgumentIssues,
        isFunctionLikeDefineDecl
    } = coreRuntime.sharedRuntime;
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
    const hoverSignature = createHoverSignatureFeature({
        t,
        buildSig,
        splitTopLevel,
        buildCallArgLayout,
        collectCallArgumentIssues,
        createHoverTypeAnalysisCache: () => ({}),
        resolveIndexedAccessValidationChain: () => [],
        parseIndexedAccessExpression: () => null,
        parseDimsParts: () => [],
        explainIndexedAccessDimCompat: () => '',
        isFunctionLikeDefineDecl
    });
    const documentedMacroSignature = hoverSignature.buildColoredSignatureLine(
        {
            type: 'define',
            name: 'Forwards_RegAndCallP',
            args: '%1,%2,[%3],[%4]',
            macroStyle: 'paren',
            value: '',
            docs: 'Forwards_RegAndCallP(const name[], const stopType, [... param_types], [... param_values]);'
        },
        2,
        ['"VipM_OnInitModules"', 'ET_IGNORE', 'FP_CELL'],
        [],
        { validateArgs: false }
    );
    assert(
        documentedMacroSignature.text.includes('Forwards_RegAndCallP(const name[], const stopType, [... param_types]') &&
            documentedMacroSignature.text.includes('[... param_values])'),
        `macro call hover should render documented parameter names, got: ${documentedMacroSignature.text}`
    );
    const commentedCallArgs = splitTopLevelWithRanges(
        `
MODULE_NAME,
// TODO: Read "Menus" as param
PCParam("MainMenuTitle", DEFAULT_PARAMS_STR_NAME),
PCParam("ResetCountOnSpawn", DEFAULT_PARAMS_BOOL_NAME), // deprecated
PCParam("AutoopenLimits", VIPM_PARAM_TYPE_LIMITS_NAME)
`.trim(),
        100
    );
    assert(
        commentedCallArgs.length === 4 &&
            commentedCallArgs[1].text === 'PCParam("MainMenuTitle", DEFAULT_PARAMS_STR_NAME)' &&
            commentedCallArgs[2].text === 'PCParam("ResetCountOnSpawn", DEFAULT_PARAMS_BOOL_NAME)' &&
            commentedCallArgs[3].text === 'PCParam("AutoopenLimits", VIPM_PARAM_TYPE_LIMITS_NAME)',
        `call argument splitter should ignore comments, got: ${commentedCallArgs.map(part => part.text).join(' | ')}`
    );
    const taggedMultilineInitializerDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-tagged-multiline-initializer.sma'),
        `
stock send_json(data, message, photoUrl, messageDest, protectContent, messageEffectId, urlMethod, callbackContextId)
{
    new EzJSON:object = CreateRequestBody(
        data,
        message,
        photoUrl,
        messageDest,
        protectContent,
        messageEffectId
    );

    if (object == EzInvalid_JSON)
        return;

    PostTelegramRequest(urlMethod, object, callbackContextId);
}
`.trimStart()
    );
    const taggedMultilineCtx = coreRuntime.sharedRuntime.getPawnDocumentContext(taggedMultilineInitializerDocument, 14);
    const taggedObjectDecl = taggedMultilineCtx.parsedDecls.locals.find(decl =>
        decl.type === 'variable' &&
        decl.name === 'object' &&
        decl.typeTag === 'EzJSON'
    );
    assert(
        taggedObjectDecl && taggedObjectDecl.scopeEndLine >= 14,
        `tagged multiline initializer should keep local object in scope, got: ${JSON.stringify(taggedObjectDecl || null)}`
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
    const taggedMultilineDiagnostics = liveValidation.collectLiveValidationDiagnostics(taggedMultilineInitializerDocument);
    assert(
        !taggedMultilineDiagnostics.some(diagnostic => /unknown symbol.*object/i.test(diagnostic.message)),
        `tagged multiline initializer should not report object as unknown, got: ${taggedMultilineDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    const commentedCallDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-commented-call-args.sma'),
        `
native VipM_Modules_AddParamsEx(const moduleName[], const any:...);
stock PCParam(const name[], const typeName[]) {
    return 0;
}

new const MODULE_NAME[] = "WeaponMenu";
new const DEFAULT_PARAMS_STR_NAME[] = "str";
new const DEFAULT_PARAMS_BOOL_NAME[] = "bool";
new const VIPM_PARAM_TYPE_LIMITS_NAME[] = "limits";

public main()
{
    VipM_Modules_AddParamsEx(MODULE_NAME,
        // TODO: Read "Menus" as param
        PCParam("MainMenuTitle", DEFAULT_PARAMS_STR_NAME),
        PCParam("ResetCountOnSpawn", DEFAULT_PARAMS_BOOL_NAME), // deprecated
        PCParam("AutoopenLimits", VIPM_PARAM_TYPE_LIMITS_NAME)
    );
}
`.trimStart()
    );
    const commentedCallDiagnostics = liveValidation.collectLiveValidationDiagnostics(commentedCallDocument);
    assert(
        !commentedCallDiagnostics.some(diagnostic => /unknown symbol.*(?:Read|as|param|deprecated)/i.test(diagnostic.message)),
        `comments inside call arguments should not produce unknown symbol diagnostics, got: ${commentedCallDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    const multilineReturnElseDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-multiline-return-else.sma'),
        `
native min(left, right);

GetUserLeftItems()
{
    new maxPlayer = 1;
    new maxMenu = 2;
    new usedPlayer = 3;
    new usedMenu = 4;

    if (maxPlayer < 0) {
        return maxMenu - usedMenu;
    } else if (maxMenu < 0) {
        return maxPlayer - usedPlayer;
    } else {
        return min(
            maxPlayer - usedPlayer,
            maxMenu - usedMenu
        );
    }
}

public main()
{
    return GetUserLeftItems();
}
`.trimStart()
    );
    const multilineReturnElseDiagnostics = liveValidation.collectLiveValidationDiagnostics(multilineReturnElseDocument);
    assert(
        !multilineReturnElseDiagnostics.some(diagnostic => /should return a value|unreachable code/i.test(diagnostic.message)),
        `if/else multiline return chain should not produce terminal-flow diagnostics, got: ${multilineReturnElseDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    const guardReturnDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-guard-return-single-statement.sma'),
        `
native server_print(const fmt[], any:...)

public guard_return(id)
{
    if(!id)
    return

    server_print("%d", id)
}
`.trimStart()
    );
    const guardReturnDiagnostics = liveValidation.collectLiveValidationDiagnostics(guardReturnDocument);
    assert(
        !guardReturnDiagnostics.some(diagnostic => /unreachable code/i.test(diagnostic.message)),
        `guard return without braces should not make following statements unreachable, got: ${guardReturnDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    const macroLoopContinueDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-macro-loop-continue.sma'),
        `
#define Each(%1) \\
    if (%1) \\
        for (new i = 0; i < 4; i++)

public main()
{
    Each(1) {
        continue;
    }
    return 0;
}
`.trimStart()
    );
    const macroLoopContinueDiagnostics = liveValidation.collectLiveValidationDiagnostics(macroLoopContinueDocument);
    assert(
        !macroLoopContinueDiagnostics.some(diagnostic => /continue.*out of context/i.test(diagnostic.message)),
        `loop-like function macro body should allow continue, got: ${macroLoopContinueDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    const singleStatementDeclScopeDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-single-statement-decl-scope.sma'),
        `
native json_array_get_string(value, index, buffer[], maxlen)
native charsmax(any:array[])

public main(value)
{
    new size = 1;
    for (new j; j < size; j++)
        new soundPath[128];
    json_array_get_string(value, 0, soundPath, charsmax(soundPath));
}
`.trimStart()
    );
    const singleStatementDeclScopeContext = coreRuntime.sharedRuntime.getPawnDocumentContext(
        singleStatementDeclScopeDocument,
        undefined,
        { preparseLocals: true }
    );
    const singleStatementSoundPathDecl = singleStatementDeclScopeContext.parsedDecls.locals.find(decl => decl.name === 'soundPath');
    assert(
        singleStatementSoundPathDecl?.scopeEndLine === 7,
        `single-statement body declaration should stay scoped to the body line, got: ${JSON.stringify(singleStatementSoundPathDecl || null)}`
    );
    const bracedForDeclScopeDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-braced-for-decl-scope.sma'),
        `
native json_array_get_string(value, index, buffer[], maxlen)
native charsmax(any:array[])

public main(value)
{
    new size = 1;
    for (new j; j < size; j++) {
        new soundPath[128];
        json_array_get_string(value, j, soundPath, charsmax(soundPath));
    }
}
`.trimStart()
    );
    const bracedForDeclScopeContext = coreRuntime.sharedRuntime.getPawnDocumentContext(
        bracedForDeclScopeDocument,
        undefined,
        { preparseLocals: true }
    );
    const bracedForSoundPathDecl = bracedForDeclScopeContext.parsedDecls.locals.find(decl => decl.name === 'soundPath');
    assert(
        bracedForSoundPathDecl?.scopeEndLine >= 8,
        `braced for body declaration should stay visible through the loop block, got: ${JSON.stringify(bracedForSoundPathDecl || null)}`
    );
    const bracedForDeclScopeDiagnostics = liveValidation.collectLiveValidationDiagnostics(bracedForDeclScopeDocument);
    assert(
        !bracedForDeclScopeDiagnostics.some(diagnostic => /unknown symbol: soundPath|unknown symbol.*soundPath/i.test(diagnostic.message)),
        `braced for body declaration should be visible within the loop block, got: ${bracedForDeclScopeDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
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

    const permissiveConstructsDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-permissive-constructs.sma'),
        `
new
    globalOne, globalTwo

enum Flags(<<=1) {
    FLAG1 = 1,
    FLAG2
}

new var3
#define _var3 var3

public main()
{
    new
        localOne, localTwo

    globalOne = FLAG2
    globalTwo = globalOne
    localOne = 1
    localTwo = localOne
    _var3 = localTwo
    return globalTwo + _var3
}
`.trimStart()
    );
    const permissiveConstructsContext = coreRuntime.sharedRuntime.getPawnDocumentContext(
        permissiveConstructsDocument,
        undefined,
        { preparseLocals: true }
    );
    const permissiveGlobals = permissiveConstructsContext.parsedDecls.globals;
    const parsedLocals = permissiveConstructsContext.parsedDecls.locals;
    assert(
        permissiveGlobals.some(decl => decl.name === 'globalOne') &&
        permissiveGlobals.some(decl => decl.name === 'globalTwo'),
        'bare declaration keyword on its own line should continue into the next global declaration line'
    );
    assert(
        parsedLocals.some(decl => decl.name === 'localOne') &&
        parsedLocals.some(decl => decl.name === 'localTwo'),
        'bare declaration keyword on its own line should continue into the next local declaration line'
    );
    const flag2 = permissiveGlobals.find(decl => decl.type === 'enum-item' && decl.name === 'FLAG2');
    assert(flag2?.value === '2', `enum shift step should parse <<=1 and auto-value FLAG2 to 2, got: ${flag2?.value}`);
    const permissiveConstructsDiagnostics = liveValidation.collectLiveValidationDiagnostics(permissiveConstructsDocument);
    assert(
        permissiveConstructsDiagnostics.length === 0,
        `valid permissive Pawn constructs should not report diagnostics, got: ${permissiveConstructsDiagnostics.map(diagnostic => `${diagnostic.message} @ ${permissiveConstructsDocument.getText(diagnostic.range)}`).join(' | ')}`
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
    const underscoreValueDefineDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-underscore-value-define.sma'),
        `
#include <underscore_value>

new const value[] = _UNDERSCORE_INCLUDE_VALUE;
`.trimStart()
    );
    const underscoreValueDefineContext = coreRuntime.sharedRuntime.getPawnDocumentContext(underscoreValueDefineDocument);
    const underscoreValueDefineDecls = new Set(underscoreValueDefineContext.incDecls
        .filter(decl => decl.type === 'define')
        .map(decl => decl.name));
    assert(
        underscoreValueDefineDecls.has('_UNDERSCORE_INCLUDE_VALUE'),
        'include define declarations with underscore names and values should be visible'
    );
    assert(
        !underscoreValueDefineDecls.has('_UNDERSCORE_INCLUDE_GUARD'),
        'empty underscore include guard defines should stay hidden from symbols'
    );
    const underscoreValueDefineDiagnostics = liveValidation.collectLiveValidationDiagnostics(underscoreValueDefineDocument);
    assert(
        !underscoreValueDefineDiagnostics.some(diagnostic => /unknown symbol.*_UNDERSCORE_INCLUDE_VALUE/i.test(diagnostic.message)),
        `underscore value define from include should not be reported as unknown, got: ${underscoreValueDefineDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    const quotedIncludeAtEofDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-quoted-include-at-eof.sma'),
        '#include "hard_inc"'
    );
    const quotedIncludeAtEofDiagnostics = liveValidation.collectLiveValidationDiagnostics(quotedIncludeAtEofDocument);
    assert(
        !quotedIncludeAtEofDiagnostics.some(diagnostic => diagnostic.message === t('validation.invalidString')),
        `quoted include at EOF should not be treated as an unterminated string, got: ${quotedIncludeAtEofDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    assert(
        getIncludeNameFromLine('#include bare_root') === 'bare_root',
        'bare include directive should parse without angle brackets or quotes'
    );
    const bareIncludeIssues = getPreprocessorDirectiveIssues(parsePreprocessorDirectiveLine('#include bare_root'));
    assert(
        !bareIncludeIssues.length,
        `bare include directive should not be reported as invalid, got: ${bareIncludeIssues.map(issue => issue.messageKey).join(', ')}`
    );
    const bareIncludeDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-bare-include.sma'),
        `
#include bare_root

public main()
{
    return BARE_ROOT_SYMBOL + BARE_CHILD_SYMBOL;
}
`.trimStart()
    );
    const bareIncludeContext = coreRuntime.sharedRuntime.getPawnDocumentContext(bareIncludeDocument);
    const bareIncludeDefines = new Set(bareIncludeContext.incDecls
        .filter(decl => decl.type === 'define')
        .map(decl => decl.name));
    assert(
        bareIncludeDefines.has('BARE_ROOT_SYMBOL') && bareIncludeDefines.has('BARE_CHILD_SYMBOL'),
        'bare include directives should resolve root and nested include definitions'
    );
    const includeWithMissingNestedDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-include-with-missing-nested.sma'),
        `
#include <parent_with_missing_child>

public main()
{
    return PARENT_WITH_MISSING_CHILD;
}
`.trimStart()
    );
    const includeWithMissingNestedDiagnostics = liveValidation.collectLiveValidationDiagnostics(includeWithMissingNestedDocument);
    assert(
        !includeWithMissingNestedDiagnostics.some(diagnostic =>
            diagnostic.code === 'amxx.live.unresolvedInclude' &&
            /^include not resolved: parent_with_missing_child/i.test(diagnostic.message)
        ),
        `resolved parent include should not be reported as directly unresolved because of a missing nested include, got: ${includeWithMissingNestedDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    assert(
        includeWithMissingNestedDiagnostics.some(diagnostic =>
            diagnostic.code === 'amxx.live.unresolvedInclude' &&
            /include dependency not resolved: missing_nested_child .*parent_with_missing_child/i.test(diagnostic.message)
        ),
        `missing nested include should be reported as an unresolved dependency of its parent include, got: ${includeWithMissingNestedDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    const rootRelativeNestedIncludeDocument = new MockDocument(
        path.join(tempProjectRoot, 'feature-wiring-root-relative-nested-include.sma'),
        `
#include "Modules/Feature"

public main()
{
    return FEATURE_SYMBOL;
}
`.trimStart()
    );
    const rootRelativeNestedContext = coreRuntime.sharedRuntime.getPawnDocumentContext(rootRelativeNestedIncludeDocument);
    const rootRelativeNestedDefines = new Set(rootRelativeNestedContext.incDecls
        .filter(decl => decl.type === 'define')
        .map(decl => decl.name));
    assert(
        rootRelativeNestedDefines.has('FEATURE_CHILD_SYMBOL'),
        'nested path-like include should resolve from an ancestor source root when local include directory lookup misses'
    );
    const rootRelativeNestedDiagnostics = liveValidation.collectLiveValidationDiagnostics(rootRelativeNestedIncludeDocument);
    assert(
        !rootRelativeNestedDiagnostics.some(diagnostic => diagnostic.code === 'amxx.live.unresolvedInclude'),
        `root-relative nested include should not produce unresolved include diagnostics, got: ${rootRelativeNestedDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
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
    const atPublicCallbackDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-at-public-callback-forward-parent.sma'),
        `
#include <callback_parent>

@client_disconnected(id)
{
}
`.trimStart()
    );
    const atPublicCallbackContext = coreRuntime.sharedRuntime.getPawnDocumentContext(atPublicCallbackDocument);
    const atPublicCallbackDecl = atPublicCallbackContext.parsedDecls.functions.find(decl =>
        decl.name === '@client_disconnected'
    );
    assert(
        atPublicCallbackDecl?.type === 'public' &&
            (atPublicCallbackDecl.modifiers || []).includes('public') &&
            !atPublicCallbackContext.parsedDecls.functions.some(decl => decl.name === 'client_disconnected'),
        `@callback declaration should be a public function with its @-prefixed compiler name, got: ${JSON.stringify(atPublicCallbackContext.parsedDecls.functions)}`
    );
    const atPublicCallbackDiagnostics = liveValidation.collectLiveValidationDiagnostics(atPublicCallbackDocument);
    assert(
        atPublicCallbackDiagnostics.some(diagnostic => diagnostic.message === missingParameterDeclaration),
        `strict callback signature mode should fall back from @callback to unprefixed include forward, got: ${atPublicCallbackDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    const atPublicUnusedArg = t('validation.symbolNeverUsed', { name: 'id' });
    assert(
        !atPublicCallbackDiagnostics.some(diagnostic => diagnostic.message === atPublicUnusedArg),
        `@callback arguments should inherit public/forward usage suppression, got: ${atPublicCallbackDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    const atPublicPrefixedForwardDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-at-public-prefixed-forward-parent.sma'),
        `
#include <at_callback_parent>

@client_disconnected(id)
{
}
`.trimStart()
    );
    const atPublicPrefixedForwardDiagnostics = liveValidation.collectLiveValidationDiagnostics(atPublicPrefixedForwardDocument);
    assert(
        atPublicPrefixedForwardDiagnostics.some(diagnostic => diagnostic.message === missingParameterDeclaration),
        `strict callback signature mode should match @callback with @forward parent, got: ${atPublicPrefixedForwardDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );

    const compilerLikeHarness = createLiveValidationWithConfig({ callbackSignatureMode: 'compiler-like' });
    const compilerLikeCallbackDiagnostics = compilerLikeHarness.liveValidation.collectLiveValidationDiagnostics(callbackDocument);
    assert(
        !compilerLikeCallbackDiagnostics.some(diagnostic => diagnostic.message === missingParameterDeclaration),
        `compiler-like callback signature mode should allow public callbacks with omitted trailing forward parameters, got: ${compilerLikeCallbackDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    const compilerLikeUnprefixedFallbackDiagnostics = compilerLikeHarness.liveValidation.collectLiveValidationDiagnostics(atPublicCallbackDocument);
    assert(
        !compilerLikeUnprefixedFallbackDiagnostics.some(diagnostic => diagnostic.message === missingParameterDeclaration),
        `compiler-like callback signature mode should allow @callbacks with omitted trailing unprefixed include forward parameters, got: ${compilerLikeUnprefixedFallbackDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    const compilerLikeAtPublicCallbackDiagnostics = compilerLikeHarness.liveValidation.collectLiveValidationDiagnostics(atPublicPrefixedForwardDocument);
    assert(
        !compilerLikeAtPublicCallbackDiagnostics.some(diagnostic => diagnostic.message === missingParameterDeclaration),
        `compiler-like callback signature mode should allow @callbacks with omitted trailing @forward parameters, got: ${compilerLikeAtPublicCallbackDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );

    const callbackUnusedArgDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-callback-unused-args.sma'),
        `
forward sw_menu_callback(id, unused_arg)

sw_menu_callback(id, unused_arg)
{
    return id;
}
`.trimStart()
    );
    const callbackUnusedArgMessage = t('validation.symbolNeverUsed', { name: 'unused_arg' });
    const strictCallbackUnusedArgDiagnostics = liveValidation.collectLiveValidationDiagnostics(callbackUnusedArgDocument);
    assert(
        strictCallbackUnusedArgDiagnostics.some(diagnostic => diagnostic.message === callbackUnusedArgMessage),
        `strict callback signature mode should still report unused forward callback arguments, got: ${strictCallbackUnusedArgDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    const compilerLikeCallbackUnusedArgDiagnostics = compilerLikeHarness.liveValidation.collectLiveValidationDiagnostics(callbackUnusedArgDocument);
    assert(
        !compilerLikeCallbackUnusedArgDiagnostics.some(diagnostic => diagnostic.message === callbackUnusedArgMessage),
        `compiler-like callback signature mode should suppress unused arguments for forward-backed callbacks, got: ${compilerLikeCallbackUnusedArgDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
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

    const enumTagRegressionDocument = new MockDocument(
        path.join(workspaceRoot, 'feature-wiring-enum-tag-regressions.sma'),
        `
enum TestStruct
{
    TestValue
}

enum TestStruct // duplicate should still be parsed as TestStruct
{
    TestValue2
}

enum WeaponIdType
{
    WEAPON_NONE
}

enum ZombieAttributesData
{
    Float:ZombieAttr_Health
}

const WeaponIdType:WEAPON_ID = WeaponIdType:75;
const MAX_LIGHTSTYLE_LEN = 64;

native Float:bio_api_get_attributes_config(const ZombieAttributesData:key);

new gBuffer[2][MAX_LIGHTSTYLE_LEN];
new Float:gAttrs[ZombieAttributesData];
new ZombieAttributesData:gKey = ZombieAttr_Health;

main()
{
    gBuffer[1][0] = 0;
    gAttrs[ZombieAttr_Health] = bio_api_get_attributes_config(ZombieAttr_Health);
}
`.trimStart()
    );
    const enumTagRegressionDiagnostics = liveValidation.collectLiveValidationDiagnostics(enumTagRegressionDocument);
    assert(
        enumTagRegressionDiagnostics.some(diagnostic =>
            diagnostic.message === t('validation.symbolAlreadyDefined', { name: 'TestStruct' })
        ),
        `inline-comment duplicate enum header should report duplicate enum name, got: ${enumTagRegressionDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    assert(
        !enumTagRegressionDiagnostics.some(diagnostic =>
            /expected tag:\s*WeaponIdType/i.test(diagnostic.message)
        ),
        `custom enum tag cast to numeric literal should not report expected tag, got: ${enumTagRegressionDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    assert(
        !enumTagRegressionDiagnostics.some(diagnostic =>
            /unknown dimension symbol:\s*MAX_LIGHTSTYLE_LEN/i.test(diagnostic.message)
        ),
        `const scalar dimensions should resolve in indexed access, got: ${enumTagRegressionDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );
    assert(
        !enumTagRegressionDiagnostics.some(diagnostic =>
            /tag mismatch:\s*expected ZombieAttributesData,\s*got Float/i.test(diagnostic.message)
        ),
        `typed enum members should be accepted as their enum key tag in calls, got: ${enumTagRegressionDiagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });

    console.log('live-validation:feature-wiring pass');
}

main();
