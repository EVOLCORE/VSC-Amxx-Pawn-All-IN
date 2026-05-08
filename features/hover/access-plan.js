function createHoverAccessPlanFeature(deps) {
    const {
        buildAccessModelForContext,
        getVariableWordMatches,
        getLocalFirstWordMatches,
        getDeclMatchKey,
        getDisplayAccessIndex,
        getDeclarationAccessIndex,
        withDeclarationDisplayName,
        withHoverDisplayName,
        buildSymbolHoverInfo,
        buildDistinctSymbolHoverInfo,
        buildFullSymbolHoverInfo,
        createHoverRangeFromOffsets,
        joinHoverSections = (...sections) => sections.filter(Boolean).join('\n\n---\n\n')
    } = deps;

    const isAccessSelectionModel = value =>
        !!value &&
        !!value.rootCtx &&
        Object.prototype.hasOwnProperty.call(value, 'activeAccess');

    const normalizeAccessModel = accessCtxOrModel =>
        isAccessSelectionModel(accessCtxOrModel)
            ? accessCtxOrModel
            : buildAccessModelForContext(accessCtxOrModel);

    const getParentIndexedAccessEnumFieldInfo = accessCtxOrModel => {
        const model = normalizeAccessModel(accessCtxOrModel);
        const previousAccess = model?.previousAccess || null;
        const parentSymbolName = model?.previousAccessSymbolName || '';
        if (!parentSymbolName) return null;
        const matches = getLocalFirstWordMatches(parentSymbolName)
            .filter(match => match?.data?.type === 'enum-item' && !!match.data.dims);
        if (!matches.length) return null;
        return {
            matches,
            access: previousAccess,
            activeAccessIndex: model.previousAccessIndex
        };
    };

    const resolveStructuralCellAccessInfo = (accessModel, indexSymbolMatches = [], hoveredWord = '') => {
        const model = normalizeAccessModel(accessModel);
        const parentEnumFieldInfo = getParentIndexedAccessEnumFieldInfo(model);
        const parentEnumFieldMatches = parentEnumFieldInfo?.matches || [];
        const activeAccess = model?.activeAccess || null;
        const activeEnumFieldAccess = !parentEnumFieldInfo &&
            activeAccess &&
            indexSymbolMatches.some(match => match?.data?.type === 'enum-item' && !!match.data.dims)
            ? activeAccess
            : null;
        const structuralCellInfo =
            parentEnumFieldInfo &&
            activeAccess &&
            parentEnumFieldInfo.activeAccessIndex === 0
                ? parentEnumFieldInfo
                : null;
        const structuralCellSuffix = structuralCellInfo?.access
            ? `${structuralCellInfo.access.text}[]`
            : '';
        const isSelfNestedStructuralCell = !!(
            structuralCellInfo &&
            model?.activeAccessIndexedBaseName === model?.rootCtx?.baseName
        );
        const shouldShowNestedSymbolLayer = !!(
            structuralCellInfo &&
            isSelfNestedStructuralCell &&
            model?.nestedCtx &&
            model?.isNestedPrimaryBaseHover
        );
        const shouldShowIndexSymbolLayer = !!(
            structuralCellInfo &&
            !shouldShowNestedSymbolLayer &&
            hoveredWord &&
            model?.isInsideActiveAccessInterior
        );

        return {
            model,
            parentEnumFieldInfo,
            parentEnumFieldMatches,
            activeEnumFieldAccess,
            rangeAccess: parentEnumFieldInfo?.access || activeEnumFieldAccess || null,
            structuralCellInfo,
            structuralCellSuffix,
            isSelfNestedStructuralCell,
            shouldShowNestedSymbolLayer,
            shouldShowIndexSymbolLayer
        };
    };

    const resolveAccessHoverPlan = (indexedAccessCtx, accessModel, options = {}) => {
        const {
            lineStartOffset = 0,
            hoveredWord = ''
        } = options;
        const activeAccess = accessModel?.activeAccess || null;
        const nestedChain = accessModel?.nestedChain || [];
        const nestedIndexedAccessCtx = accessModel?.nestedCtx || null;
        const nestedAccessLineOffset = accessModel?.nestedAccessLineOffset || 0;
        const nestedPrimaryIndexedAccessCtx = accessModel?.nestedPrimaryCtx || null;
        const parentMatches = getVariableWordMatches(indexedAccessCtx.baseName);

        if (nestedPrimaryIndexedAccessCtx) {
            const nestedParentMatches = getVariableWordMatches(nestedPrimaryIndexedAccessCtx.baseName);
            if (nestedParentMatches.length) {
                const nestedPrimarySymbolName = accessModel?.nestedPrimaryActiveAccessSymbolName || '';
                const nestedPrimarySymbolMatches =
                    nestedIndexedAccessCtx && nestedPrimarySymbolName
                        ? getLocalFirstWordMatches(nestedPrimarySymbolName)
                        : [];
                const nestedPrimarySecondaryHover = nestedPrimarySymbolMatches.length
                    ? joinHoverSections(buildSymbolHoverInfo(nestedPrimarySymbolMatches))
                    : joinHoverSections(parentMatches.length
                        ? buildSymbolHoverInfo([withDeclarationDisplayName(parentMatches[0])], {
                            variableAccessBaseName: indexedAccessCtx.baseName,
                            variableAccessSuffix: indexedAccessCtx.suffix,
                            variableAccessActiveIndex: getDisplayAccessIndex(indexedAccessCtx),
                        })
                        : '');

                if (
                    nestedIndexedAccessCtx &&
                    nestedPrimaryIndexedAccessCtx.activeAccessIndex == null
                ) {
                    const immediateParentEntry = nestedChain.length > 1
                        ? nestedChain[nestedChain.length - 2]
                        : null;
                    const primaryAccessCtx = immediateParentEntry?.ctx || indexedAccessCtx;
                    const primaryMatches = immediateParentEntry
                        ? getVariableWordMatches(primaryAccessCtx.baseName)
                        : parentMatches;
                    if (primaryMatches.length) {
                        const isSameNestedDeclaration =
                            getDeclMatchKey(primaryMatches[0]?.data) === getDeclMatchKey(nestedParentMatches[0]?.data);
                        const structuralParentInfo = isSameNestedDeclaration
                            ? resolveStructuralCellAccessInfo(primaryAccessCtx)
                            : null;
                        const structuralParentAccess = structuralParentInfo?.structuralCellInfo?.access || null;
                        const structuralCellSuffix = structuralParentInfo?.structuralCellSuffix || '';
                        const primaryMatch = structuralParentAccess
                            ? withHoverDisplayName(
                                primaryMatches[0],
                                `${primaryAccessCtx.baseName}${structuralCellSuffix}`
                            )
                            : withDeclarationDisplayName(primaryMatches[0]);
                        const primaryAccessSuffix = structuralParentAccess
                            ? structuralCellSuffix
                            : primaryAccessCtx.suffix;
                        const primaryActiveAccessIndex = structuralParentAccess
                            ? structuralParentInfo.structuralCellInfo.activeAccessIndex + 1
                            : getDeclarationAccessIndex(primaryMatches[0], primaryAccessCtx);
                        const shouldShowNestedSymbolLayer =
                            !!structuralParentAccess &&
                            accessModel?.isNestedPrimaryBaseHover;
                        const nestedAndParentHover = joinHoverSections(
                            shouldShowNestedSymbolLayer
                                ? buildFullSymbolHoverInfo(
                                    nestedParentMatches[0],
                                    nestedPrimaryIndexedAccessCtx.baseName
                                )
                                : isSameNestedDeclaration
                                ? ''
                                : buildDistinctSymbolHoverInfo(
                                    [nestedParentMatches[0]]
                                )
                        );
                        const primaryLineOffset = immediateParentEntry && activeAccess
                            ? (activeAccess.start + 1) + immediateParentEntry.offsetBase
                            : 0;
                        return {
                            matches: [primaryMatch],
                            secondaryHoverInfo: nestedAndParentHover,
                            hoveredWord: primaryAccessCtx.baseName,
                            variableAccessSuffix: primaryAccessSuffix,
                            variableAccessActiveIndex: primaryActiveAccessIndex,
                            hoverRange: immediateParentEntry
                                ? createHoverRangeFromOffsets(
                                    lineStartOffset + primaryLineOffset + primaryAccessCtx.start,
                                    lineStartOffset + primaryLineOffset + primaryAccessCtx.end
                                )
                                : createHoverRangeFromOffsets(
                                    lineStartOffset + indexedAccessCtx.start,
                                    lineStartOffset + indexedAccessCtx.end
                                )
                        };
                    }
                }

                if (nestedIndexedAccessCtx) {
                    return {
                        matches: [withDeclarationDisplayName(nestedParentMatches[0])],
                        secondaryHoverInfo: nestedPrimarySecondaryHover,
                        hoveredWord: nestedPrimaryIndexedAccessCtx.baseName,
                        variableAccessSuffix: nestedPrimaryIndexedAccessCtx.suffix,
                        variableAccessActiveIndex: getDeclarationAccessIndex(nestedParentMatches[0], nestedPrimaryIndexedAccessCtx),
                        hoverRange: createHoverRangeFromOffsets(
                            lineStartOffset + nestedAccessLineOffset + nestedPrimaryIndexedAccessCtx.start,
                            lineStartOffset + nestedAccessLineOffset + nestedPrimaryIndexedAccessCtx.end
                        )
                    };
                }

                if (parentMatches.length) {
                    const nestedAndParentHover = joinHoverSections(
                        buildDistinctSymbolHoverInfo([nestedParentMatches[0]])
                    );
                    return {
                        matches: [withDeclarationDisplayName(parentMatches[0])],
                        secondaryHoverInfo: nestedAndParentHover,
                        hoveredWord: indexedAccessCtx.baseName,
                        variableAccessSuffix: indexedAccessCtx.suffix,
                        variableAccessActiveIndex: getDeclarationAccessIndex(parentMatches[0], indexedAccessCtx),
                        hoverRange: createHoverRangeFromOffsets(
                            lineStartOffset + indexedAccessCtx.start,
                            lineStartOffset + indexedAccessCtx.end
                        )
                    };
                }
            }
        }

        const activeAccessSymbolName = accessModel?.activeAccessSymbolName || '';
        const indexSymbolMatches = activeAccessSymbolName
            ? getLocalFirstWordMatches(activeAccessSymbolName)
            : [];
        const structuralAccessInfo = resolveStructuralCellAccessInfo(
            accessModel,
            indexSymbolMatches,
            hoveredWord || ''
        );

        if (!parentMatches.length) return null;

        if (structuralAccessInfo.structuralCellInfo?.access) {
            const indexCellHoverInfo = structuralAccessInfo.shouldShowNestedSymbolLayer
                ? buildFullSymbolHoverInfo(parentMatches[0], indexedAccessCtx.baseName)
                : structuralAccessInfo.shouldShowIndexSymbolLayer
                ? buildSymbolHoverInfo(indexSymbolMatches)
                : '';
            const structuralParentMatch = withHoverDisplayName(
                parentMatches[0],
                `${indexedAccessCtx.baseName}${structuralAccessInfo.structuralCellSuffix}`
            );
            return {
                matches: [structuralParentMatch],
                secondaryHoverInfo: indexCellHoverInfo,
                hoveredWord: indexedAccessCtx.baseName,
                variableAccessSuffix: structuralAccessInfo.structuralCellSuffix,
                variableAccessActiveIndex: structuralAccessInfo.structuralCellInfo.activeAccessIndex + 1,
                hoverRange: activeAccess
                    ? createHoverRangeFromOffsets(
                        lineStartOffset + activeAccess.start,
                        lineStartOffset + activeAccess.end
                    )
                    : null
            };
        }

        const parentPrimaryMatch = withDeclarationDisplayName(parentMatches[0]);
        const indexSymbolHoverInfo = buildSymbolHoverInfo(indexSymbolMatches, {
            variableAccessBaseName: nestedIndexedAccessCtx?.baseName || '',
            variableAccessSuffix: nestedIndexedAccessCtx?.suffix || '',
            variableAccessActiveIndex: nestedIndexedAccessCtx
                ? getDisplayAccessIndex(nestedIndexedAccessCtx)
                : null
        });
        const parentEnumFieldHoverInfo = buildSymbolHoverInfo(
            structuralAccessInfo.parentEnumFieldMatches
        );
        const secondaryHoverInfo = joinHoverSections(
            parentEnumFieldHoverInfo,
            indexSymbolHoverInfo
        );

        return {
            matches: [parentPrimaryMatch],
            secondaryHoverInfo,
            hoveredWord: indexedAccessCtx.baseName,
            variableAccessSuffix: indexedAccessCtx.suffix,
            variableAccessActiveIndex: structuralAccessInfo.parentEnumFieldInfo
                ? structuralAccessInfo.parentEnumFieldInfo.activeAccessIndex
                : getDeclarationAccessIndex(parentMatches[0], indexedAccessCtx),
            hoverRange: structuralAccessInfo.rangeAccess
                ? createHoverRangeFromOffsets(
                    lineStartOffset + structuralAccessInfo.rangeAccess.start,
                    lineStartOffset + structuralAccessInfo.rangeAccess.end
                )
                : createHoverRangeFromOffsets(
                    lineStartOffset + indexedAccessCtx.start,
                    lineStartOffset + indexedAccessCtx.end
                )
        };
    };

    return {
        resolveAccessHoverPlan
    };
}

module.exports = { createHoverAccessPlanFeature };
