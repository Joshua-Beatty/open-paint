import type { MessageId, MessageValues } from "@openpaint/i18n";
import {
  chordKey,
  chordMatches,
  formatChord,
  type KeyChord,
  type KeyEventLike,
  parseChord,
  type ShortcutPlatform,
} from "./keys";

/** The menus that group commands in the shortcut reference, in menu-bar order (SET-HELP-03). */
export const COMMAND_GROUPS = [
  "file",
  "edit",
  "view",
  "image",
  "layers",
  "adjustments",
  "effects",
  "tools",
  "help",
] as const;

export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/** A command with its default bindings, written in the spec's notation (see `parseChord`). */
export interface CommandDefinition<Id extends string = string> {
  readonly id: Id;
  readonly group: CommandGroup;
  readonly messageId: MessageId;
  readonly values?: MessageValues;
  /** The primary bindings. Each one fires the command. */
  readonly shortcuts: readonly string[];
  /** Always-active alternates for combinations the browser reserves (WEB-KEY-03). */
  readonly alternates?: readonly string[];
}

export interface CommandLabels {
  readonly shortcuts: readonly string[];
  readonly alternates: readonly string[];
}

interface Binding<Id extends string> {
  readonly id: Id;
  readonly spec: string;
  readonly chord: KeyChord;
}

/**
 * The central command registry. It validates the definitions once, rejects two commands that
 * share a chord (WEB-KEY-04 conflict detection), and finds the command for a key event. Labels
 * for the shortcut reference come from here, so the reference always matches the bindings.
 */
export class CommandRegistry<Id extends string> {
  readonly #commands = new Map<Id, CommandDefinition<Id>>();
  readonly #bindings: Binding<Id>[] = [];
  readonly #owners = new Map<string, Binding<Id>>();

  constructor(definitions: readonly CommandDefinition<Id>[]) {
    for (const definition of definitions) {
      if (this.#commands.has(definition.id)) {
        throw new Error(`Command "${definition.id}" is defined twice.`);
      }
      this.#commands.set(definition.id, definition);
      for (const spec of definition.shortcuts) this.#bind(definition.id, spec);
      for (const spec of definition.alternates ?? []) this.#bind(definition.id, spec);
    }
  }

  #bind(id: Id, spec: string): void {
    const chord = parseChord(spec);
    const binding: Binding<Id> = { id, spec, chord };
    const key = chordKey(chord);
    const owner = this.#owners.get(key);
    if (owner !== undefined) {
      throw new Error(`Shortcut "${spec}" is bound to both "${owner.id}" and "${id}".`);
    }
    this.#owners.set(key, binding);
    this.#bindings.push(binding);
  }

  /** Every command, in definition order. */
  list(): readonly CommandDefinition<Id>[] {
    return [...this.#commands.values()];
  }

  has(id: string): id is Id {
    return this.#commands.has(id as Id);
  }

  get(id: Id): CommandDefinition<Id> {
    const command = this.#commands.get(id);
    if (command === undefined) throw new Error(`Unknown command "${id}".`);
    return command;
  }

  /** The labels a menu or the reference shows for a command, in the given platform's notation. */
  labels(id: Id, platform: ShortcutPlatform): CommandLabels {
    const command = this.get(id);
    return {
      shortcuts: command.shortcuts.map((spec) => formatChord(parseChord(spec), platform)),
      alternates: (command.alternates ?? []).map((spec) => formatChord(parseChord(spec), platform)),
    };
  }

  /** The command bound to this key event, if any. */
  find(event: KeyEventLike, platform: ShortcutPlatform): Id | undefined {
    return this.#bindings.find((binding) => chordMatches(binding.chord, event, platform))?.id;
  }
}
