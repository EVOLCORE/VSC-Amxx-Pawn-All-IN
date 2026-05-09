const { createHoverAccessPlanFeature } = require('./access-plan');

function createHoverAccessHoverFeature(deps) {
    const {
        vscode,
        buildHoverMarkdown,
        buildArgHoverInfo,
        buildDistinctArgHoverInfo,
        buildIndexedAccessSelectionModel,
        createHoverRangeFromOffsets,
        getActiveCallSignatureHoverData,
        getDeclMatchKey,
        getLocalFirstWordMatches,
        getVariableWordMatches,
        parseDimsParts,
        resolveArgumentSymbolName,
        resolver,
        position,
        lineStartOffset,
        tokenRange,
        fp,
        allDecls,
        bitmaskCtx,
        bitmaskPartCtx,
        funcArgs,
        locals,
        globals,
        functions,
        incDecls,
        lookup
    } = deps;

    const getDisplayAccessIndex = accessCtx =>
        accessCtx?.accesses?.length
            ? (accessCtx.activeAccessIndex != null ? accessCtx.activeAccessIndex : 0)
            : null;

    const getDeclarationAccessIndex = (match, accessCtx) => {
        const accessIndex = getDisplayAccessIndex(accessCtx);
        if (accessIndex == null) return null;
        const dimParts = parseDimsParts(match?.data?.dims || '');
        const dimCount = Array.isArray(dimParts) ? dimParts.length : 0;
        return dimCount > 0 ? Math.min(accessIndex, dimCount - 1) : accessIndex;
    };

    const withDeclarationDisplayName = match => {
        if (!match?.data?.hoverDisplayName) return match;
        return {
            ...match,
            data: {
                ...match.data,
                hoverDisplayName: ''
            }
        };
    };

    const withHoverDisplayName = (match, hoverDisplayName) => {
        if (!match?.data || !hoverDisplayName) return match;
        return {
            ...match,
            data: {
                ...match.data,
                hoverDisplayName
            }
        };
    };

    const buildFullSymbolHoverInfo = (match, hoveredWord = '') => {
        if (!match?.data) return '';
        const markdown = buildHoverMarkdown(
            [withDeclarationDisplayName(match)],
            null,
            null,
            allDecls,
            '',
            fp,
            null,
            funcArgs,
            locals,
            globals,
            functions,
            incDecls,
            null,
            {
                hoveredWord: hoveredWord || match.data.name || '',
                lookup
            }
        );
        return typeof markdown?.value === 'string' ? markdown.value : String(markdown || '');
    };

    const joinHoverSections = (...sections) =>
        sections.filter(Boolean).join('\n\n---\n\n');

    const buildAccessHover = ({
        matches: accessMatches,
        secondaryHoverInfo = '',
        hoverRange = null,
        hoveredWord = '',
        variableAccessSuffix = '',
        variableAccessActiveIndex = null,
        suppressVariableEnumSections = true,
        suppressDescriptions = true,
        hoverBitmaskPartCtx = bitmaskPartCtx,
        includeCallParent = false
    }) => {
        const callSignatureHover = includeCallParent
            ? getActiveCallSignatureHoverData()
            : null;
        const matches = callSignatureHover
            ? [callSignatureHover.match, ...accessMatches]
            : accessMatches;
        return new vscode.Hover(
            buildHoverMarkdown(
                matches,
                callSignatureHover?.argIndex ?? null,
                callSignatureHover?.callSiteArgs ?? null,
                allDecls,
                secondaryHoverInfo,
                fp,
                bitmaskCtx,
                funcArgs,
                locals,
                globals,
                functions,
                incDecls,
                hoverBitmaskPartCtx,
                {
                    suppressVariableEnumSections,
                    suppressDescriptions,
                    hoveredWord,
                    variableAccessSuffix,
                    variableAccessActiveIndex,
                    lookup
                }
            ),
            hoverRange || tokenRange || undefined
        );
    };

    const buildAccessModelForContext = accessCtx => buildIndexedAccessSelectionModel(
        accessCtx,
        accessCtx?.accesses?.[accessCtx?.activeAccessIndex]?.start ?? -1,
        resolver.ctrlCharAtLine(position.line),
        {
            resolveSymbolName: expr => resolveArgumentSymbolName(null, expr, '') || ''
        }
    );

    const { resolveAccessHoverPlan } = createHoverAccessPlanFeature({
        buildAccessModelForContext,
        getVariableWordMatches,
        getLocalFirstWordMatches,
        getDeclMatchKey,
        getDisplayAccessIndex,
        getDeclarationAccessIndex,
        withDeclarationDisplayName,
        withHoverDisplayName,
        buildSymbolHoverInfo: (matchList, options = {}) => buildArgHoverInfo(
            matchList,
            fp,
            false,
            { allDecls, lookup, ...options }
        ),
        buildDistinctSymbolHoverInfo: matchList => buildDistinctArgHoverInfo(
            matchList,
            false,
            { allDecls, lookup }
        ),
        buildFullSymbolHoverInfo,
        createHoverRangeFromOffsets,
        joinHoverSections
    });

    function resolveIndexedAccessHover({
        taggedIndexedAccessCtx,
        indexedAccessContext,
        indexedAccessHoverCtx,
        word
    }) {
        if (taggedIndexedAccessCtx) {
            const tagBaseMatches = getVariableWordMatches(taggedIndexedAccessCtx.baseName);
            if (tagBaseMatches.length) {
                return buildAccessHover({
                    matches: tagBaseMatches,
                    hoveredWord: taggedIndexedAccessCtx.baseName,
                    suppressVariableEnumSections: false,
                    suppressDescriptions: true,
                    hoverRange: createHoverRangeFromOffsets(
                        lineStartOffset + taggedIndexedAccessCtx.tagStart,
                        lineStartOffset + taggedIndexedAccessCtx.tagCastEnd
                    ) || tokenRange
                });
            }
        }

        if (
            indexedAccessContext &&
            word &&
            word === indexedAccessContext.baseName &&
            position.character >= indexedAccessContext.baseStart &&
            position.character < indexedAccessContext.baseEnd
        ) {
            const baseVariableMatches = getVariableWordMatches(indexedAccessContext.baseName);
            if (baseVariableMatches.length) {
                const includeCallParent = !!getActiveCallSignatureHoverData();
                return buildAccessHover({
                    matches: baseVariableMatches,
                    hoveredWord: indexedAccessContext.baseName,
                    variableAccessSuffix: '',
                    variableAccessActiveIndex: null,
                    suppressVariableEnumSections: includeCallParent,
                    suppressDescriptions: includeCallParent,
                    includeCallParent,
                    hoverRange: tokenRange || createHoverRangeFromOffsets(
                        lineStartOffset + indexedAccessContext.baseStart,
                        lineStartOffset + indexedAccessContext.baseEnd
                    )
                });
            }
        }

        if (indexedAccessHoverCtx) {
            const accessModel = buildIndexedAccessSelectionModel(
                indexedAccessHoverCtx,
                position.character,
                resolver.ctrlCharAtLine(position.line),
                {
                    hoveredWord: word || '',
                    resolveSymbolName: expr => resolveArgumentSymbolName(null, expr, '') || ''
                }
            );
            const accessHoverPlan = resolveAccessHoverPlan(indexedAccessHoverCtx, accessModel, {
                lineStartOffset,
                hoveredWord: word || ''
            });
            if (accessHoverPlan) return buildAccessHover(accessHoverPlan);
        }

        return null;
    }

    return {
        resolveIndexedAccessHover
    };
}

module.exports = { createHoverAccessHoverFeature };
