import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

export const TUI_COMMANDS = [
  "help",
  "new",
  "sessions",
  "use",
  "older",
  "newer",
  "review",
  "improve",
  "queue",
  "btw",
  "session",
  "schedule",
  "kb",
  "test",
  "self-opt",
  "config",
  "doctor",
  "copy",
  "reload-skills",
  "reload-config",
  "stats",
  "actions",
  "resume",
  "cancel",
  "exit",
] as const;

export function createTuiAutocomplete(basePath: string): CombinedAutocompleteProvider {
  return new CombinedAutocompleteProvider(
    TUI_COMMANDS.map((value) => ({ value, label: `/${value}` })),
    basePath,
  );
}
