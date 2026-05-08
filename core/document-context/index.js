const { createDocumentContextCore } = require('./runtime');
const { createDocumentCacheUtils } = require('./cache-utils');
const { createDocumentIncludeSystem } = require('./pawn-includes');
const { createDocumentContextUtilityCore } = require('./document-utils');
const { createDocumentContextStateCore } = require('./state');
const { createFileSnapshotCore } = require('./file-snapshot');

module.exports = {
    createDocumentContextCore,
    createDocumentCacheUtils,
    createDocumentIncludeSystem,
    createDocumentContextUtilityCore,
    createDocumentContextStateCore,
    createFileSnapshotCore
};
