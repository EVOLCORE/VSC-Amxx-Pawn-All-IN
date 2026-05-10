// Hover content rendering lives separately from hover-provider orchestration so
// we can later optimize or move buildHoverAtPosition without dragging along the
// large markdown/signature formatting layer.
function createHoverContentFeature(deps) {
    const {
        vscode,
        t,
        getHoverContentMode,
        isSameFilePath,
        buildCommandLink,
        buildSig,
        isFunctionLikeDecl,
        buildColoredVariableAccessLine,
        buildColoredSignatureLine,
        buildEnumMemberLine,
        getEnumDeclsForVariableDims,
        buildBitmaskParts,
        formatBitmaskValueHex,
        formatBitmaskSetBits,
        extractBitmaskLiteralPartLines,
        parseDimsParts,
        parseDimSpec,
        measurePawnStringLiteral,
        getActiveCtrlChar,
        getLiveValidationIssueMode,
        areLiveValidationWarningsEnabled
    } = deps;
    const areHoverWarningIssuesEnabled = () =>
        areLiveValidationWarningsEnabled(getLiveValidationIssueMode());

    function appendEnumMembersSection(md, enumDecl, title = 'Members') {
        if (!Array.isArray(enumDecl?.enumMembers) || !enumDecl.enumMembers.length) return;
        const resolvedCount = String(enumDecl.value || '').trim();
        const countText = /^-?\d+$/.test(resolvedCount)
            ? resolvedCount
            : String(enumDecl.enumMembers.length);
        md.appendMarkdown(`\n\n### ${title}\nCount: ${countText}`);
        md.appendMarkdown('\n');
        md.appendCodeblock(enumDecl.enumMembers.map(buildEnumMemberLine).join('\n'), 'amxxpawn');
    }

    function normalizeEnumInfoName(name) {
        return String(name || '').replace(/^_?\s*:\s*/, '').trim();
    }

    function buildArgHoverInfo(matches, currentFilePath = '', includeDocs = true, options = {}) {
        if (!matches?.length) return '';
        const {
            allDecls = [],
            lookup = null,
            variableAccessBaseName = '',
            variableAccessSuffix = '',
            variableAccessActiveIndex = null,
            validateVariableAccess = true,
            preserveHoverDisplayNameWithAccess = false
        } = options;
        const parts = [];
        for (const { label, data } of matches) {
            const signatureData =
                data?.hoverDisplayName && !preserveHoverDisplayNameWithAccess
                    ? { ...data, hoverDisplayName: '' }
                    : data;
            const fileLabel = data.file && !isSameFilePath(data.filePath, currentFilePath) ? ` \`${data.file}\`` : '';
            const link = data.filePath ? ` ${buildCommandLink(t('hover.goToDefinition'), data.filePath, data.lineNumber)}` : '';
            const docsText = data.docs || data.enumDocs || '';
            const docs = includeDocs && docsText ? `\n\n*${docsText}*` : '';
            const variableAccessInfo =
                data?.type === 'variable' &&
                variableAccessSuffix &&
                data.name === variableAccessBaseName
                    ? buildColoredVariableAccessLine(
                        data,
                        variableAccessSuffix,
                        allDecls,
                        variableAccessActiveIndex,
                        lookup,
                        {
                            validateAccess: validateVariableAccess,
                            includeWarnings: areHoverWarningIssuesEnabled()
                        }
                    )
                : null;
            const accessBlock = variableAccessInfo
                ? `\n\n\`\`\`amxxpawn\n${variableAccessInfo.text.split('\n').slice(1).join('\n')}\n\`\`\`` +
                    (variableAccessInfo.errorDetails?.length
                        ? `\n\n### ${t('hover.accessErrors')}\n${variableAccessInfo.errorDetails.map(detail =>
                            `- \`${detail.dimText}\`${detail.actualExpr ? ` with \`${detail.actualExpr}\`` : ''}: ${detail.reason}`
                        ).join('\n')}`
                        : '')
                : '';
            parts.push(
                `**${label}**${fileLabel}${link}\n\n` +
                '```amxxpawn\n' + buildSig(signatureData, { allDecls, lookup }) + '\n```' +
                accessBlock +
                docs
            );
        }
        return parts.join('\n\n---\n\n');
    }

    function appendHoverMatchSection(md, match, currentFilePath = '', options = {}) {
        const { label, data, nav } = match;
        const includeSignature = options.includeSignature !== false;
        const includeDescription = options.includeDescription !== false;
        md.appendMarkdown(`**${label}**`);
        if (data.file && !isSameFilePath(data.filePath, currentFilePath)) {
            md.appendMarkdown(` \`${data.file}\``);
        }
        if (nav && data.filePath) {
            md.appendMarkdown(` ${buildCommandLink(t('hover.goToDefinition'), data.filePath, data.lineNumber)}`);
        }
        if (includeSignature) {
            md.appendMarkdown('\n\n');
            md.appendCodeblock(buildSig(data, {
                allDecls: options.allDecls || [],
                lookup: options.lookup || null
            }), 'amxxpawn');
        }

        const docsText = data.docs || data.enumDocs || '';
        if (includeDescription && docsText) {
            md.appendMarkdown(`\n\n### ${t('hover.description')}\n${docsText}`);
        }
    }

    function appendBitmaskHoverSection(md, bitmaskCtx, funcArgs, locals, globals, functions, incDecls, currentFilePath = '', lookup = null) {
        if (!bitmaskCtx) return;

        md.appendMarkdown(`**${t('hover.combinedBits')}**\n\n`);
        md.appendCodeblock(`${bitmaskCtx.expr}\n= ${bitmaskCtx.value}`, 'amxxpawn');

        const infoLines = [`Value: ${bitmaskCtx.value}`];
        const hexValue = formatBitmaskValueHex(bitmaskCtx.value);
        if (hexValue) infoLines.push(`Hex: ${hexValue}`);
        const setBits = formatBitmaskSetBits(bitmaskCtx.value);
        if (setBits) infoLines.push(`Bits set: ${setBits}`);
        md.appendMarkdown(`\n\n### ${t('hover.kind.info')}\n${infoLines.join('  \n')}`);

        const namedParts = buildBitmaskParts(
            bitmaskCtx.words || [],
            funcArgs,
            locals,
            globals,
            functions,
            incDecls,
            lookup
        );
        const literalPartLines = extractBitmaskLiteralPartLines(bitmaskCtx.expr, [
            ...funcArgs,
            ...locals,
            ...globals,
            ...incDecls
        ]);
        const partLines = [
            ...namedParts.map(part => buildSig(part.data)),
            ...literalPartLines
        ];

        if (partLines.length) {
            md.appendMarkdown(`\n\n### ${t('hover.kind.parts')}\n`);
            md.appendCodeblock(partLines.join('\n'), 'amxxpawn');
        }
    }

    function appendBitmaskPartHoverSection(md, bitmaskPartCtx) {
        if (!bitmaskPartCtx) return;

        md.appendMarkdown(`**Bit**\n\n`);
        md.appendCodeblock(`${bitmaskPartCtx.expr}\n= ${bitmaskPartCtx.value}`, 'amxxpawn');

        const infoLines = [`Value: ${bitmaskPartCtx.value}`];
        const hexValue = formatBitmaskValueHex(bitmaskPartCtx.value);
        if (hexValue) infoLines.push(`Hex: ${hexValue}`);
        const setBits = formatBitmaskSetBits(bitmaskPartCtx.value);
        if (setBits) infoLines.push(`Bits set: ${setBits}`);
        md.appendMarkdown(`\n\n### ${t('hover.kind.info')}\n${infoLines.join('  \n')}`);
    }

    function buildStructuredEnumFieldHover(
        enumDecl,
        member,
        fieldExpr,
        currentFilePath = '',
        escapeChar = getActiveCtrlChar(),
        allDecls = [],
        prefixMatches = [],
        bitmaskCtx = null,
        funcArgs = [],
        locals = [],
        globals = [],
        functions = [],
        incDecls = []
    ) {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        for (let idx = 0; idx < prefixMatches.length; idx++) {
            if (idx > 0) md.appendMarkdown('\n\n---\n\n');
            appendHoverMatchSection(md, prefixMatches[idx], currentFilePath, { allDecls });
        }

        if (prefixMatches.length && bitmaskCtx) {
            md.appendMarkdown('\n\n---\n\n');
        }
        if (bitmaskCtx) {
            appendBitmaskHoverSection(md, bitmaskCtx, funcArgs, locals, globals, functions, incDecls, currentFilePath);
        }

        if (prefixMatches.length || bitmaskCtx) {
            md.appendMarkdown('\n\n---\n\n');
        }

        md.appendMarkdown(`**${t('hover.enumField')}**`);
        if (!isSameFilePath(enumDecl.filePath, currentFilePath)) {
            md.appendMarkdown(` \`${enumDecl.file}\``);
        }
        if (member.filePath) {
            md.appendMarkdown(` ${buildCommandLink(t('hover.goToDefinition'), member.filePath, member.lineNumber)}`);
        }
        md.appendMarkdown('\n\n');
        md.appendCodeblock(buildSig(member, { allDecls }), 'amxxpawn');

        const infoLines = [];
        const enumDisplayName = String(enumDecl.enumDisplayName || '').trim();
        const enumContainerName = String(enumDecl.name || '').trim();
        const normalizedEnumDisplayName = normalizeEnumInfoName(enumDisplayName);
        const normalizedEnumContainerName = normalizeEnumInfoName(enumContainerName);
        if (enumDisplayName) {
            infoLines.push(`Enum: \`${enumDisplayName}\``);
        }
        if (
            enumContainerName &&
            normalizedEnumContainerName &&
            normalizedEnumContainerName !== normalizedEnumDisplayName
        ) {
            infoLines.push(`Container: \`${enumContainerName}\``);
        }
        if (Array.isArray(enumDecl.enumMembers)) {
            const memberIndex = enumDecl.enumMembers.findIndex(item => item.name === member.name);
            if (memberIndex >= 0) {
                infoLines.push(`Member: ${memberIndex + 1}/${enumDecl.enumMembers.length}`);
            }
        }
        if (member.dims) {
            const dimParts = parseDimsParts(member.dims);
            const firstDim = dimParts[0];
            const dimSpec = parseDimSpec(firstDim, allDecls);
            const shapeDuplicatesCapacity =
                dimParts.length === 1 &&
                dimSpec.capacity != null &&
                String(firstDim || '').trim() === String(dimSpec.capacity);
            if (!shapeDuplicatesCapacity) {
                infoLines.push(`Shape: \`${member.dims}\``);
            }
            if (dimSpec.capacity != null) {
                infoLines.push(`Capacity: ${dimSpec.capacity}${dimSpec.isChar ? ' char-bytes' : ''}`);
                const measure = measurePawnStringLiteral(fieldExpr, escapeChar);
                if (measure) {
                    infoLines.push(`String: ${measure.chars} chars, ${measure.bytes} UTF-8 bytes (${measure.bytesWithTerminator} with NUL)`);
                    infoLines.push(measure.bytesWithTerminator <= dimSpec.capacity ? 'Fits: yes' : 'Fits: no');
                }
            }
        }

        if (infoLines.length) {
            md.appendMarkdown('\n\n### Info\n');
            md.appendMarkdown(infoLines.join('  \n'));
        }

        const memberDocs = String(member.docs || '').trim();
        const enumDocs = String(enumDecl.docs || member.enumDocs || '').trim();
        if (memberDocs && memberDocs !== enumDocs) {
            md.appendMarkdown(`\n\n### ${t('hover.memberDescription')}\n${memberDocs}`);
        }
        if (enumDocs) {
            md.appendMarkdown(`\n\n### ${t('hover.enumDescription')}\n${enumDocs}`);
        }

        return md;
    }

    function buildHoverMarkdown(
        matches,
        callArgIndex,
        callSiteArgs,
        allDecls,
        argHoverInfo = '',
        currentFilePath = '',
        bitmaskCtx = null,
        funcArgs = [],
        locals = [],
        globals = [],
        functions = [],
        incDecls = [],
        bitmaskPartCtx = null,
        options = {}
    ) {
        const {
            validateSignatureArgs = true,
            signatureValidationMode = 'call',
            forceColoredSignature = false,
            variableAccessSuffix = '',
            variableAccessActiveIndex = null,
            suppressVariableEnumSections = false,
            hoveredWord = '',
            lookup = null,
            validateVariableAccess = true,
            signatureArgLayout = null
        } = options;
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        const hoverContentMode = getHoverContentMode();
        const isCompactMode = hoverContentMode === 'compact';
        const isSignatureOnlyMode = hoverContentMode === 'signature-only';
        const trailingDescriptions = [];
        const trailingAliases = [];
        const seenAliases = new Set();
        const hasPrimaryFunctionNameHover = !!hoveredWord && matches.some(match =>
            isFunctionLikeDecl(match?.data) && (
                match.data.name === hoveredWord ||
                match.data.hoverDisplayName === hoveredWord ||
                match.data.aliasName === hoveredWord
            )
        );
        const suppressDescriptions = options.suppressDescriptions ??
            (callArgIndex != null && !hasPrimaryFunctionNameHover);
        const suppressTrailingDescriptions = suppressDescriptions || isCompactMode || isSignatureOnlyMode;

        for (let idx = 0; idx < matches.length; idx++) {
            if (idx > 0) md.appendMarkdown('\n\n---\n\n');
            const { data } = matches[idx];
            const isFunc = isFunctionLikeDecl(data);
            const showColoredSignature = isFunc && (callArgIndex != null || forceColoredSignature);
            const variableAccessInfo =
                data.type === 'variable' && variableAccessSuffix && data.name === hoveredWord
                    ? buildColoredVariableAccessLine(
                        data,
                        variableAccessSuffix,
                        allDecls,
                        variableAccessActiveIndex,
                        options.lookup || null,
                        {
                            validateAccess: validateVariableAccess,
                            includeWarnings: areHoverWarningIssuesEnabled()
                        }
                    )
                    : null;
            const baseSignatureMatch = matches[idx];

            appendHoverMatchSection(md, baseSignatureMatch, currentFilePath, {
                includeSignature: !showColoredSignature,
                includeDescription: false,
                allDecls,
                lookup
            });

            if (showColoredSignature) {
                const signatureInfo = buildColoredSignatureLine(data, callArgIndex, callSiteArgs, allDecls, {
                    validateArgs: validateSignatureArgs,
                    validationMode: signatureValidationMode,
                    lookup: options.lookup || null,
                    precomputedCallArgLayout: signatureArgLayout,
                    includeWarnings: areHoverWarningIssuesEnabled()
                });
                md.appendMarkdown('\n\n');
                md.appendCodeblock(signatureInfo.text, 'amxxpawn');
                if (signatureInfo.errorDetails?.length) {
                    const lines = signatureInfo.errorDetails.map(detail =>
                        `- \`${detail.paramText}\`: ${detail.reason}`
                    );
                    md.appendMarkdown(`\n\n### ${t('hover.signatureErrors')}\n${lines.join('\n')}`);
                }
            }

            if (variableAccessInfo) {
                md.appendMarkdown('\n\n');
                md.appendCodeblock(
                    variableAccessInfo.text.split('\n').slice(1).join('\n'),
                    'amxxpawn'
                );
                if (variableAccessInfo.errorDetails?.length) {
                    const lines = variableAccessInfo.errorDetails.map(detail =>
                        `- \`${detail.dimText}\`${detail.actualExpr ? ` with \`${detail.actualExpr}\`` : ''}: ${detail.reason}`
                    );
                    md.appendMarkdown(`\n\n### ${t('hover.accessErrors')}\n${lines.join('\n')}`);
                }
            }

            if (!isSignatureOnlyMode && data.type === 'enum') {
                appendEnumMembersSection(md, data);
            }

            if (!isSignatureOnlyMode && !isCompactMode && data.type === 'variable' && !suppressVariableEnumSections) {
                const linkedEnums = getEnumDeclsForVariableDims(data, allDecls, options.lookup || null);
                for (const enumDecl of linkedEnums) {
                    const title = enumDecl.enumDisplayName || enumDecl.name
                        ? t('hover.structMembersNamed', { name: enumDecl.enumDisplayName || enumDecl.name })
                        : t('hover.structMembers');
                    appendEnumMembersSection(md, enumDecl, title);
                }
            }

            const docsText = data.docs || data.enumDocs || '';
            if (!suppressTrailingDescriptions && docsText) {
                trailingDescriptions.push(`### ${t('hover.description')}\n${docsText}`);
            }

            if (!isSignatureOnlyMode && data.aliasDefineDecl) {
                const aliasDefine = data.aliasDefineDecl;
                const aliasKey = [
                    data.aliasName || data.hoverDisplayName || aliasDefine.name || '',
                    data.aliasTargetName || data.name || '',
                    aliasDefine.filePath || '',
                    aliasDefine.lineNumber ?? '',
                    aliasDefine.value || ''
                ].join('|');
                if (!seenAliases.has(aliasKey)) {
                    seenAliases.add(aliasKey);
                    trailingAliases.push(aliasDefine);
                }
            }
        }

        if (bitmaskCtx) {
            if (matches.length) md.appendMarkdown('\n\n---\n\n');
            appendBitmaskHoverSection(
                md,
                bitmaskCtx,
                funcArgs,
                locals,
                globals,
                functions,
                incDecls,
                currentFilePath,
                lookup
            );
        }

        if (bitmaskPartCtx) {
            if (matches.length || bitmaskCtx) md.appendMarkdown('\n\n---\n\n');
            appendBitmaskPartHoverSection(md, bitmaskPartCtx);
        }

        if (!isSignatureOnlyMode && argHoverInfo) {
            if (matches.length || bitmaskCtx || bitmaskPartCtx) md.appendMarkdown('\n\n---\n\n');
            md.appendMarkdown(argHoverInfo);
        }

        if (trailingDescriptions.length) {
            md.appendMarkdown('\n\n---\n\n');
            md.appendMarkdown(trailingDescriptions.join('\n\n'));
        }

        if (trailingAliases.length) {
            md.appendMarkdown('\n\n---\n\n');
            for (let index = 0; index < trailingAliases.length; index++) {
                if (index > 0) md.appendMarkdown('\n\n');
                const aliasDefine = trailingAliases[index];
                md.appendMarkdown(`### ${t('hover.alias')}`);
                if (aliasDefine.file && !isSameFilePath(aliasDefine.filePath, currentFilePath)) {
                    md.appendMarkdown(` \`${aliasDefine.file}\``);
                }
                if (aliasDefine.filePath) {
                    md.appendMarkdown(` ${buildCommandLink(t('hover.goToDefinition'), aliasDefine.filePath, aliasDefine.lineNumber)}`);
                }
                md.appendCodeblock(buildSig(aliasDefine, { allDecls, lookup }), 'amxxpawn');
            }
        }

        return md;
    }

    return {
        buildArgHoverInfo,
        buildStructuredEnumFieldHover,
        buildHoverMarkdown
    };
}

module.exports = { createHoverContentFeature };
