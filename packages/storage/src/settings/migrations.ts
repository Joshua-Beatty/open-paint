/** The settings schema version this build writes (SET-STO-01). The first version is 1. */
export const SETTINGS_SCHEMA_VERSION = 1;

/**
 * One ordered step from schema version `from` to `from + 1` (SET-STO-01). It edits the stored
 * records in place (renames, value conversions) before any setting is read. Records it does not
 * touch are kept, including keys this build does not know.
 */
export interface SettingsMigration {
  readonly from: number;
  readonly migrate: (records: Map<string, unknown>) => void;
}

/** The migrations from earlier schema versions. Version 1 is the first, so there are none yet. */
export const SETTINGS_MIGRATIONS: readonly SettingsMigration[] = [];
