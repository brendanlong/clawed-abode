# Settings UI

- Every settings card is a `shared/SettingsCard` (title, description, `isLoading`); every free-text setting is a `shared/EditableTextSetting`; every model field is a `shared/ModelOverrideField` (edit/save/clear) or, for plain form state, `shared/ModelCombobox`.
- Edit-in-place fields take the tRPC `useMutation` result as `mutation` (`shared/save-mutation.ts`) and render `mutation.error`. Never keep error text in `useState` — React Query already resets it on the next `mutate`, and the fields call `mutation.reset()` when the editor opens or closes.
- Global-settings cards live in `global/`; `GeneralTab` only composes them.
- The routers hand back secret values already masked (`••••••••`), so a form must never echo the value it was given back to a set-mutation — submit `''` for an untouched secret, which is the server's "keep the stored value" protocol (`doc/settings.md`). Sending the mask overwrites the real secret with the bullets.
- That protocol keys off the **submitted** `isSecret`, not the stored one, so `''` only means "keep" when the submission is still secret. A form must require a non-empty value everywhere else — including when the user flips Secret off on an existing secret, which would otherwise store the empty string.
- `EnvVarSection`/`McpServerSection` call `onUpdate()` themselves after a delete resolves; don't also hang `onSuccess` on the delete mutation or every delete refetches twice.
- The TTS voice chooser is `VoicePicker` (search box, capped rows, nothing mounted while closed), never a `Select`: Firefox with speech-dispatcher reports ~15,000 voices, and a Radix `Select` mounts every item even while closed, which froze the Settings page for over a minute. Treat any list fed by browser-reported data (voices, fonts, devices) the same way.
