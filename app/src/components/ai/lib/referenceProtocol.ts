/** JSON UTF-8 envelope budgets (also bound structured-clone content).
 * Two retained requests maximum; source keys/canonical copies <= source budget.
 */
export const MAX_REFERENCE_ANALYSIS_CHARS = 2_000_000;
export const MAX_REFERENCE_ANALYSIS_SOURCES = 2048;
export const MAX_REFERENCE_URL_BYTES = 8192;
export const MAX_REFERENCE_TITLE_BYTES = 4096;
export const MAX_REFERENCE_TOOL_ID_BYTES = 1024;
export const MAX_REFERENCE_SOURCE_BYTES = 256 * 1024;
export const MAX_REFERENCE_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_REFERENCE_RESPONSE_BYTES = 256 * 1024;
export const MAX_REFERENCE_RETAINED_REQUEST_BYTES = 2 * MAX_REFERENCE_REQUEST_BYTES;
// UI can retain one previously accepted text snapshot as a prefix projection,
// in addition to in-flight/latest. Keys/canonical source copies are separately
// bounded by MAX_REFERENCE_SOURCE_BYTES; response arrays by response budget.
export const MAX_REFERENCE_RETAINED_TEXT_BYTES = 3 * MAX_REFERENCE_REQUEST_BYTES;
