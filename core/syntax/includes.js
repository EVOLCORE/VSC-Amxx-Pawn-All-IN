const PAWN_INCLUDE_LINE_RE = /^\s*#\s*(include|tryinclude)\b\s+(?:<([^>"]+)>\s*|"([^"]+)"\s*|([A-Za-z0-9_./\\-]+))/i;

function parsePawnIncludeDirectiveTarget(lineText = '') {
    const text = String(lineText || '');
    const match = text.match(PAWN_INCLUDE_LINE_RE);
    if (!match) return null;

    const keyword = String(match[1] || '').toLowerCase();
    const angleName = match[2] || '';
    const quotedName = match[3] || '';
    const bareName = match[4] || '';
    const name = angleName || quotedName || bareName;
    if (!name) return null;

    const matchedText = match[0] || '';
    const nameStartInMatch = matchedText.lastIndexOf(name);
    if (nameStartInMatch < 0) return null;

    const nameStart = (match.index || 0) + nameStartInMatch;
    const nameEnd = nameStart + name.length;
    const isDelimited = !!(angleName || quotedName);

    return {
        keyword,
        name,
        nameStart,
        nameEnd,
        tokenStart: isDelimited ? Math.max(0, nameStart - 1) : nameStart,
        tokenEnd: isDelimited ? Math.min(text.length, nameEnd + 1) : nameEnd,
        isDelimited,
        delimiter: angleName ? '<>' : (quotedName ? '""' : '')
    };
}

function getPawnIncludeNameFromLine(lineText = '') {
    return parsePawnIncludeDirectiveTarget(lineText)?.name || '';
}

module.exports = {
    PAWN_INCLUDE_LINE_RE,
    parsePawnIncludeDirectiveTarget,
    getPawnIncludeNameFromLine
};
