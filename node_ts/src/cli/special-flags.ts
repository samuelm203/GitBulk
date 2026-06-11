/**
 * Spezial-CLI-Flags, die VOR `node:util.parseArgs` abgefangen werden müssen:
 *
 *   - `-fish` / `-fisch` (auch `--fish`/`--fisch`): kompakte Befehls-Matrix.
 *   - `-owner` (auch `--owner`): Easter Egg mit ASCII-Header.
 *
 * Warum vor parseArgs? `parseArgs` würde `-fish` als Kurzoptionen-Cluster
 * (`-f -i -s -h`) fehldeuten und mit einem Fehler abbrechen. Beides sind reine
 * Ausgabe-Flags ohne Seiteneffekte → eigenes, unit-testbares Modul.
 */

import * as colors from '../utils/colors.js';

/**
 * `-fish` / `-fisch`: kompakte, strukturierte Befehls-/Options-Matrix.
 */
export function fishHelp(useColor: boolean): string {
  const b = (s: string): string => (useColor ? colors.bold(s) : s);
  const lines = [
    b('gitbulk — command & option matrix'),
    '',
    b('  COMMAND                  KEY OPTIONS                                  WHAT IT DOES'),
    '  gitbulk                  -c/--config, -m/--mode, --dry-run, --tui,    Run the bulk flow (per-RU git + PR)',
    '                           --gui, --deep-log, --only, -l/--log-level',
    '  gitbulk init             -o/--output, -f/--force                      Generate an operations config or a .mjs/.ts script',
    '  gitbulk list-operations  --json                                       List the declarative operations + parameters',
    '',
    b('  GLOBAL'),
    '  -v/--version   Print version          --no-color    Disable colored output',
    '  -h/--help      Show the full help     -fish/-fisch  This matrix',
    '',
    'Full help: gitbulk --help',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * `-owner`: Easter Egg. Sauberer ASCII-Header + GitHub-Handle des Autors.
 */
export function ownerEasterEgg(useColor: boolean): string {
  const banner = String.raw`
   ____ _ _   ____        _ _
  / ___(_) |_| __ ) _   _| | | __
 | |  _| | __|  _ \ | | | | | |/ /
 | |_| | | |_| |_) | |_| | |   <
  \____|_|\__|____/ \__,_|_|_|\_\
`;
  const head = useColor ? colors.cyan(banner) : banner;
  const handle = useColor ? colors.bold('GITHUB: samuelm203') : 'GITHUB: samuelm203';
  return `${head}\n${handle}\n`;
}

/**
 * Prüft die rohen CLI-Argumente auf Spezial-Flags.
 *
 * @returns die auszugebende Zeichenkette, oder `undefined`, wenn kein
 *          Spezial-Flag vorliegt (dann läuft der normale Argument-Parser).
 */
export function handleSpecialFlags(rawArgs: readonly string[], useColor: boolean): string | undefined {
  const has = (...names: string[]): boolean => rawArgs.some((a) => names.includes(a));
  if (has('-fish', '--fish', '-fisch', '--fisch')) {
    return fishHelp(useColor);
  }
  if (has('-owner', '--owner')) {
    return ownerEasterEgg(useColor);
  }
  return undefined;
}
