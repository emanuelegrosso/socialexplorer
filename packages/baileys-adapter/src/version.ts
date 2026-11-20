export const BAILEYS_PACKAGE = "@whiskeysockets/baileys" as const;
/** Exact pin; must match package.json and docs/baileys-compatibility.md. */
export const BAILEYS_VERSION = "7.0.0-rc14" as const;

/** Close status code that means the linked device was removed and a new pairing is required. */
export const LOGGED_OUT_STATUS_CODE = 401;
export const RESTART_REQUIRED_STATUS_CODE = 515;
export const CONNECTION_REPLACED_STATUS_CODE = 440;
