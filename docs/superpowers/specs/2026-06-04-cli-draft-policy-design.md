## Goal

Make prompt importing consistent across the popup, local CLI, and `@gpt生图插件` flow when the popup input still contains an older prompt draft.

## Behavior

1. Prompt draft replacement only applies to the popup input draft stored in `popupDraft.promptText`.
2. Existing queued tasks are never deleted or changed by draft replacement choices.
3. CLI import supports explicit draft policies:
   - `--replace-draft`: replace the popup draft with the incoming prompts, then import them.
   - `--keep-draft`: keep the existing popup draft unchanged, but still import the new prompts.
4. If the popup draft contains different prompt text and the CLI import does not specify either policy flag, the import must fail with a clear error that asks the caller to choose.
5. If no popup draft exists, CLI import succeeds without a policy flag and writes the imported prompts into the popup draft so the UI reflects the latest import.
6. `status` should expose popup draft state so Codex can inspect it before importing through `@gpt生图插件`.

## Implementation Shape

- `background.js`
  - Read `STORAGE_KEYS.POPUP_DRAFT` in state helpers.
  - Add a helper that compares the stored popup draft with the incoming prompt text and resolves whether to keep, replace, or reject.
  - Extend `importPrompts()` to honor an optional `draftPolicy`.
  - Include normalized draft information in `getPublicState()`.

- `cli.js`
  - Extend `import` parsing with `--replace-draft` and `--keep-draft`.
  - Reject conflicting flags.
  - Pass `draftPolicy` through the native host payload.

- `popup.js`
  - Keep the existing confirmation UX.
  - Pass an explicit draft policy during imports so popup-driven imports and CLI-driven imports share the same backend rules.

- `@gpt生图插件`
  - Update the skill instructions to check `status.draft` before importing.
  - If an older draft exists, ask the user whether to clear or keep it before issuing the final CLI import command.

## Testing

- CLI parsing tests for the new flags and mutual exclusion.
- Background decision tests for:
  - no existing draft
  - conflicting draft without policy
  - conflicting draft with `keep`
  - conflicting draft with `replace`
- Existing popup draft-confirmation tests stay green.
