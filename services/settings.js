const path = require('path');
const { createUtilityCore } = require('../core/utils/runtime');
const { normalizeHoverMode } = require('../core/hover-modes');
const {
    DEFAULT_CUSTOM_INCLUDE_FILE_EXTENSIONS,
    getEffectiveIncludeFileExtensions
} = require('../core/include-extensions');
const { normalizeCompletionCallArgumentMode } = require('../core/completion/call-argument-mode');

const {
    normalizeLiveValidationIssueMode
} = createUtilityCore();

function createSettingsService(vscode) {
    const CONFIG_NAMESPACE = 'amxxPawnAllIn';
    const CONFIG_KEYS = Object.freeze({
        fileExtensions: `${CONFIG_NAMESPACE}.fileExtensions`,
        includeFileExtensions: `${CONFIG_NAMESPACE}.includeFileExtensions`,
        detectPawnLanguageByIncludes: `${CONFIG_NAMESPACE}.detectPawnLanguageByIncludes`,
        globalIncludePaths: `${CONFIG_NAMESPACE}.globalIncludePaths`,
        projectLocalIncludePaths: `${CONFIG_NAMESPACE}.projectLocalIncludePaths`,
        documentContextCacheFileLimit: `${CONFIG_NAMESPACE}.documentContextCacheFileLimit`,
        includeDocumentWarmupFileLimit: `${CONFIG_NAMESPACE}.includeDocumentWarmupFileLimit`,
        persistentIncludeDeclarationCacheMaxMB: `${CONFIG_NAMESPACE}.persistentIncludeDeclarationCacheMaxMB`,
        liveValidationMode: `${CONFIG_NAMESPACE}.liveValidationMode`,
        liveValidationIssueMode: `${CONFIG_NAMESPACE}.liveValidationIssueMode`,
        liveValidationScanOnOpen: `${CONFIG_NAMESPACE}.liveValidationScanOnOpen`,
        liveValidationTypingDelayMs: `${CONFIG_NAMESPACE}.liveValidationTypingDelayMs`,
        unusedStockValidationMode: `${CONFIG_NAMESPACE}.unusedStockValidationMode`,
        callbackSignatureMode: `${CONFIG_NAMESPACE}.callbackSignatureMode`,
        includeValidationMode: `${CONFIG_NAMESPACE}.includeValidationMode`,
        externalIncludeWatchMode: `${CONFIG_NAMESPACE}.externalIncludeWatchMode`,
        debugOutput: `${CONFIG_NAMESPACE}.debugOutput`,
        completionEnabled: `${CONFIG_NAMESPACE}.completionEnabled`,
        completionStatementSemicolon: `${CONFIG_NAMESPACE}.completionStatementSemicolon`,
        completionForwardDeclarationStyle: `${CONFIG_NAMESPACE}.completionForwardDeclarationStyle`,
        completionCallArgumentMode: `${CONFIG_NAMESPACE}.completionCallArgumentMode`,
        completionAutoHideDelayMs: `${CONFIG_NAMESPACE}.completionAutoHideDelayMs`,
        hoverMode: `${CONFIG_NAMESPACE}.hoverMode`,
        hoverContentMode: `${CONFIG_NAMESPACE}.hoverContentMode`,
        showThemeRecommendation: `${CONFIG_NAMESPACE}.showThemeRecommendation`,
        persistentHoverMode: `${CONFIG_NAMESPACE}.persistentHoverMode`,
        hoverGoToDefinitionLinksEnabled: `${CONFIG_NAMESPACE}.hoverGoToDefinitionLinksEnabled`,
        workbenchColorTheme: 'workbench.colorTheme'
    });

    const SETTINGS_REFRESH_CONFIG_KEYS = Object.freeze([
        CONFIG_KEYS.fileExtensions,
        CONFIG_KEYS.includeFileExtensions,
        CONFIG_KEYS.detectPawnLanguageByIncludes,
        CONFIG_KEYS.globalIncludePaths,
        CONFIG_KEYS.projectLocalIncludePaths,
        CONFIG_KEYS.documentContextCacheFileLimit,
        CONFIG_KEYS.includeDocumentWarmupFileLimit,
        CONFIG_KEYS.persistentIncludeDeclarationCacheMaxMB,
        CONFIG_KEYS.liveValidationMode,
        CONFIG_KEYS.liveValidationIssueMode,
        CONFIG_KEYS.liveValidationScanOnOpen,
        CONFIG_KEYS.liveValidationTypingDelayMs,
        CONFIG_KEYS.unusedStockValidationMode,
        CONFIG_KEYS.callbackSignatureMode,
        CONFIG_KEYS.includeValidationMode,
        CONFIG_KEYS.externalIncludeWatchMode,
        CONFIG_KEYS.debugOutput,
        CONFIG_KEYS.completionEnabled,
        CONFIG_KEYS.completionStatementSemicolon,
        CONFIG_KEYS.completionForwardDeclarationStyle,
        CONFIG_KEYS.completionCallArgumentMode,
        CONFIG_KEYS.completionAutoHideDelayMs,
        CONFIG_KEYS.hoverMode,
        CONFIG_KEYS.hoverContentMode,
        CONFIG_KEYS.showThemeRecommendation,
        CONFIG_KEYS.persistentHoverMode,
        CONFIG_KEYS.hoverGoToDefinitionLinksEnabled
    ]);
    const CACHE_RESET_CONFIG_KEYS = Object.freeze([
        CONFIG_KEYS.fileExtensions,
        CONFIG_KEYS.includeFileExtensions,
        CONFIG_KEYS.globalIncludePaths,
        CONFIG_KEYS.projectLocalIncludePaths,
        CONFIG_KEYS.documentContextCacheFileLimit,
        CONFIG_KEYS.persistentIncludeDeclarationCacheMaxMB,
        CONFIG_KEYS.unusedStockValidationMode,
        CONFIG_KEYS.callbackSignatureMode,
        CONFIG_KEYS.includeValidationMode
    ]);
    const THEME_RECOMMENDATION_CONFIG_KEYS = Object.freeze([
        CONFIG_KEYS.showThemeRecommendation,
        CONFIG_KEYS.workbenchColorTheme
    ]);
    const HOVER_RELEVANT_CONFIG_KEYS = Object.freeze([
        CONFIG_KEYS.hoverMode,
        CONFIG_KEYS.hoverContentMode,
        CONFIG_KEYS.hoverGoToDefinitionLinksEnabled,
        CONFIG_KEYS.liveValidationIssueMode,
        CONFIG_KEYS.globalIncludePaths,
        CONFIG_KEYS.projectLocalIncludePaths,
        CONFIG_KEYS.includeFileExtensions
    ]);
    const PERSISTENT_HOVER_RELEVANT_CONFIG_KEYS = Object.freeze([
        CONFIG_KEYS.globalIncludePaths,
        CONFIG_KEYS.projectLocalIncludePaths,
        CONFIG_KEYS.includeFileExtensions,
        CONFIG_KEYS.liveValidationIssueMode,
        CONFIG_KEYS.hoverMode,
        CONFIG_KEYS.hoverContentMode,
        CONFIG_KEYS.hoverGoToDefinitionLinksEnabled,
        CONFIG_KEYS.persistentHoverMode
    ]);
    const VALIDATION_DIAGNOSTIC_CONFIG_KEYS = Object.freeze([
        CONFIG_KEYS.fileExtensions,
        CONFIG_KEYS.includeFileExtensions,
        CONFIG_KEYS.globalIncludePaths,
        CONFIG_KEYS.projectLocalIncludePaths,
        CONFIG_KEYS.liveValidationIssueMode,
        CONFIG_KEYS.unusedStockValidationMode,
        CONFIG_KEYS.callbackSignatureMode,
        CONFIG_KEYS.includeValidationMode
    ]);

    const settings = {
        pawnFileExtensions: ['.sma'],
        includeFileExtensions: getEffectiveIncludeFileExtensions(DEFAULT_CUSTOM_INCLUDE_FILE_EXTENSIONS),
        detectPawnLanguageByIncludes: true,
        documentContextCacheFileLimit: 0,
        includeDocumentWarmupFileLimit: 6,
        persistentIncludeDeclarationCacheMaxBytes: 24 * 1024 * 1024,
        liveValidationMode: 'edited',
        liveValidationIssueMode: 'errors-and-warnings',
        liveValidationScanOnOpen: true,
        liveValidationTypingDelayMs: 700,
        unusedStockValidationMode: 'reachable-only',
        callbackSignatureMode: 'strict',
        includeValidationMode: 'balanced',
        debugOutput: false,
        completionEnabled: true,
        completionStatementSemicolon: true,
        completionForwardDeclarationStyle: 'same-line',
        completionCallArgumentMode: 'required-before-default',
        completionAutoHideDelayMs: 0,
        hoverMode: 'normal',
        hoverContentMode: 'full',
        showThemeRecommendation: true,
        persistentHoverMode: 'normal',
        hoverGoToDefinitionLinksEnabled: false,
        globalIncludePaths: [],
        projectLocalIncludePaths: ['include'],
        externalIncludeWatchMode: 'tracked-resolved-includes'
    };

    const affectsAnyConfiguration = (event, keys) => keys.some(key => event.affectsConfiguration(key));

    function refresh() {
        const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
        const rawPawnFileExtensions = config.get('fileExtensions', ['.sma']);
        settings.pawnFileExtensions = (Array.isArray(rawPawnFileExtensions) ? rawPawnFileExtensions : ['.sma'])
            .map(normalizeExtensionSettingValue)
            .filter(Boolean);
        const rawIncludeFileExtensions = config.get('includeFileExtensions', [...DEFAULT_CUSTOM_INCLUDE_FILE_EXTENSIONS]);
        settings.includeFileExtensions = getEffectiveIncludeFileExtensions(
            (Array.isArray(rawIncludeFileExtensions) ? rawIncludeFileExtensions : [...DEFAULT_CUSTOM_INCLUDE_FILE_EXTENSIONS])
                .map(normalizeExtensionSettingValue)
                .filter(Boolean),
            { useDefaultCustomWhenEmpty: false }
        );
        settings.detectPawnLanguageByIncludes = !!config.get('detectPawnLanguageByIncludes', true);

        const rawDocumentContextCacheFileLimit = Number(config.get('documentContextCacheFileLimit', 0));
        settings.documentContextCacheFileLimit =
            Number.isFinite(rawDocumentContextCacheFileLimit) && rawDocumentContextCacheFileLimit > 0
                ? Math.floor(rawDocumentContextCacheFileLimit)
                : 0;

        const rawIncludeDocumentWarmupFileLimit = Number(config.get('includeDocumentWarmupFileLimit', 6));
        settings.includeDocumentWarmupFileLimit =
            Number.isFinite(rawIncludeDocumentWarmupFileLimit)
                ? (rawIncludeDocumentWarmupFileLimit < -1 ? -1 : Math.floor(rawIncludeDocumentWarmupFileLimit))
                : 6;
        const rawPersistentIncludeDeclarationCacheMaxMB = Number(config.get('persistentIncludeDeclarationCacheMaxMB', 24));
        const persistentIncludeDeclarationCacheMaxMB = Number.isFinite(rawPersistentIncludeDeclarationCacheMaxMB)
            ? Math.floor(rawPersistentIncludeDeclarationCacheMaxMB)
            : 24;
        settings.persistentIncludeDeclarationCacheMaxBytes =
            Math.max(0, Math.min(256, persistentIncludeDeclarationCacheMaxMB)) * 1024 * 1024;

        const rawLiveValidationMode = String(config.get('liveValidationMode', 'edited') || 'edited').trim().toLowerCase();
        settings.liveValidationMode =
            rawLiveValidationMode === 'edited' || rawLiveValidationMode === 'full'
                ? rawLiveValidationMode
                : 'edited';
        settings.liveValidationIssueMode = normalizeLiveValidationIssueMode(
            config.get('liveValidationIssueMode', 'errors-and-warnings')
        );
        settings.liveValidationScanOnOpen = !!config.get('liveValidationScanOnOpen', true);
        const rawLiveValidationTypingDelayMs = Number(config.get('liveValidationTypingDelayMs', 700));
        settings.liveValidationTypingDelayMs = Number.isFinite(rawLiveValidationTypingDelayMs)
            ? Math.max(0, Math.min(5000, Math.floor(rawLiveValidationTypingDelayMs)))
            : 700;
        const rawUnusedStockValidationMode = String(config.get('unusedStockValidationMode', 'reachable-only') || 'reachable-only').trim().toLowerCase();
        settings.unusedStockValidationMode =
            rawUnusedStockValidationMode === 'skip' || rawUnusedStockValidationMode === 'all'
                ? rawUnusedStockValidationMode
                : 'reachable-only';
        const rawCallbackSignatureMode = String(config.get('callbackSignatureMode', 'strict') || 'strict').trim().toLowerCase();
        settings.callbackSignatureMode =
            rawCallbackSignatureMode === 'compiler-like'
                ? rawCallbackSignatureMode
                : 'strict';
        const rawIncludeValidationMode = String(config.get('includeValidationMode', 'balanced') || 'balanced').trim().toLowerCase();
        settings.includeValidationMode =
            rawIncludeValidationMode === 'strict'
                ? rawIncludeValidationMode
                : 'balanced';
        const rawExternalIncludeWatchMode = String(config.get('externalIncludeWatchMode', 'tracked-resolved-includes') || 'tracked-resolved-includes').trim().toLowerCase();
        settings.externalIncludeWatchMode =
            rawExternalIncludeWatchMode === 'workspace-only' || rawExternalIncludeWatchMode === 'workspace-and-global'
                ? rawExternalIncludeWatchMode
                : 'tracked-resolved-includes';
        settings.debugOutput = !!config.get('debugOutput', false);
        settings.completionEnabled = !!config.get('completionEnabled', true);
        settings.completionStatementSemicolon = !!config.get('completionStatementSemicolon', true);
        const rawCompletionForwardDeclarationStyle =
            String(config.get('completionForwardDeclarationStyle', 'same-line') || 'same-line').trim().toLowerCase();
        settings.completionForwardDeclarationStyle =
            rawCompletionForwardDeclarationStyle === 'disabled' || rawCompletionForwardDeclarationStyle === 'next-line'
                ? rawCompletionForwardDeclarationStyle
                : 'same-line';
        settings.completionCallArgumentMode = normalizeCompletionCallArgumentMode(
            config.get('completionCallArgumentMode', 'required-before-default')
        );
        const rawCompletionAutoHideDelayMs = Number(config.get('completionAutoHideDelayMs', 0));
        settings.completionAutoHideDelayMs = Number.isFinite(rawCompletionAutoHideDelayMs)
            ? Math.max(0, Math.min(10000, Math.floor(rawCompletionAutoHideDelayMs)))
            : 0;

        settings.hoverMode = normalizeHoverMode(config.get('hoverMode', 'normal'));
        const rawHoverContentMode = String(config.get('hoverContentMode', 'full') || 'full').trim().toLowerCase();
        settings.hoverContentMode =
            rawHoverContentMode === 'compact' || rawHoverContentMode === 'signature-only'
                ? rawHoverContentMode
                : 'full';
        settings.showThemeRecommendation = !!config.get('showThemeRecommendation', true);
        const rawPersistentHoverMode = String(config.get('persistentHoverMode', 'normal') || 'normal').trim().toLowerCase();
        settings.persistentHoverMode =
            rawPersistentHoverMode === 'disabled' || rawPersistentHoverMode === 'error-context'
                ? rawPersistentHoverMode
                : 'normal';
        settings.hoverGoToDefinitionLinksEnabled = !!config.get('hoverGoToDefinitionLinksEnabled', false);

        const rawGlobalIncludePaths = config.get('globalIncludePaths', []);
        settings.globalIncludePaths = Array.isArray(rawGlobalIncludePaths) ? rawGlobalIncludePaths : [];

        const rawProjectLocalIncludePaths = config.get('projectLocalIncludePaths', ['include']);
        settings.projectLocalIncludePaths =
            Array.isArray(rawProjectLocalIncludePaths)
                ? rawProjectLocalIncludePaths
                : ['include'];
    }

    function matchesConfiguredPawnFileExtension(filePath) {
        const fileName = path.basename(String(filePath || '')).toLowerCase();
        if (!fileName) return false;
        const languageExtensions = [
            ...(settings.pawnFileExtensions || []),
            ...(settings.includeFileExtensions || [])
        ];
        return languageExtensions.some(ext => fileName.endsWith(ext));
    }

    function normalizeExtensionSettingValue(value) {
        let text = String(value || '').trim().toLowerCase();
        if (!text) return '';
        if (!text.startsWith('.')) text = `.${text}`;
        return text;
    }

    return {
        CONFIG_KEYS,
        SETTINGS_REFRESH_CONFIG_KEYS,
        CACHE_RESET_CONFIG_KEYS,
        THEME_RECOMMENDATION_CONFIG_KEYS,
        HOVER_RELEVANT_CONFIG_KEYS,
        PERSISTENT_HOVER_RELEVANT_CONFIG_KEYS,
        VALIDATION_DIAGNOSTIC_CONFIG_KEYS,
        affectsAnyConfiguration,
        refresh,
        matchesConfiguredPawnFileExtension,
        getPawnFileExtensions: () => settings.pawnFileExtensions,
        getIncludeFileExtensions: () => settings.includeFileExtensions,
        shouldDetectPawnLanguageByIncludes: () => settings.detectPawnLanguageByIncludes,
        getDocumentContextCacheFileLimit: () => settings.documentContextCacheFileLimit,
        getIncludeDocumentWarmupFileLimit: () => settings.includeDocumentWarmupFileLimit,
        isPersistentIncludeDeclarationCacheEnabled: () => settings.persistentIncludeDeclarationCacheMaxBytes > 0,
        getPersistentIncludeDeclarationCacheMaxBytes: () => settings.persistentIncludeDeclarationCacheMaxBytes,
        getLiveValidationMode: () => settings.liveValidationMode,
        getLiveValidationIssueMode: () => settings.liveValidationIssueMode,
        shouldRunLiveValidationScanOnOpen: () => settings.liveValidationScanOnOpen,
        getLiveValidationTypingDelayMs: () => settings.liveValidationTypingDelayMs,
        getUnusedStockValidationMode: () => settings.unusedStockValidationMode,
        getCallbackSignatureMode: () => settings.callbackSignatureMode,
        getIncludeValidationMode: () => settings.includeValidationMode,
        getExternalIncludeWatchMode: () => settings.externalIncludeWatchMode,
        isDebugOutputEnabled: () => settings.debugOutput,
        isCompletionEnabled: () => settings.completionEnabled,
        shouldInsertCompletionStatementSemicolon: () => settings.completionStatementSemicolon,
        getCompletionForwardDeclarationStyle: () => settings.completionForwardDeclarationStyle,
        getCompletionCallArgumentMode: () => settings.completionCallArgumentMode,
        getCompletionAutoHideDelayMs: () => settings.completionAutoHideDelayMs,
        getHoverMode: () => settings.hoverMode,
        getHoverContentMode: () => settings.hoverContentMode,
        shouldShowThemeRecommendation: () => settings.showThemeRecommendation,
        getPersistentHoverMode: () => settings.persistentHoverMode,
        isPersistentHoverEnabled: () => settings.persistentHoverMode !== 'disabled',
        isHoverGoToDefinitionLinksEnabled: () => settings.hoverGoToDefinitionLinksEnabled,
        getGlobalIncludePaths: () => settings.globalIncludePaths,
        getProjectLocalIncludePaths: () => settings.projectLocalIncludePaths
    };
}

module.exports = { createSettingsService };
