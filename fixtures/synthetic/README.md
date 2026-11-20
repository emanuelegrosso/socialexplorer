# Synthetic fixtures (WX-004)

Everything in this directory is **100% synthetic**. No personal data, real phone numbers, real JIDs, real exports, or credentials may ever be added here. CI and tests use these files only.

Allowed identifier conventions:

- Names: `Alice Example`, `Bob Sample`, `Carol Placeholder`, `Synthetic Hiking Club`.
- Phone-like values: `+1 555-01xx` style (reserved fictional range) or JID users `1555100000x`.
- Group IDs: `12036300000000000x@g.us`. LIDs: `0000000x@lid`.
- Links: placeholder IDs such as `EXAMPLE0001` on public provider domains; they are never fetched.

## Text exports (`exports/`)

| File | Format | Covers |
| --- | --- | --- |
| `android-private.txt` | Android `DD/MM/YYYY, HH:MM - Sender: text` | Multiline, system lines, `<Media omitted>`, `(file attached)` lines, Spotify/YouTube/Apple Music links, emoji/UTF-8, partial line (`25:99`), unparsed line (`32/13/2026`), post-midnight, deleted-message markers |
| `android-group.txt` | Android | Group create/add/left system lines, multiline list, media markers, links, exact duplicate lines (dedup candidates), RTL/Cyrillic Unicode |
| `ios-private.txt` | iOS `[DD/MM/YY, HH:MM:SS] Sender: text` | Invisible `U+200E` LTR marks, `U+200F` RTL mark, multiline, `<attached: ...>`, `image omitted`, `sticker omitted`, links, partial (`99:99:99`) and malformed-bracket lines |
| `ios-group.txt` | iOS | Group system lines, attachment markers, links, Unicode |

Intentional edge lines (not bugs): impossible times/dates and malformed brackets exist to exercise `parseStatus: partial | unparsed`.

## ZIP archives (`zips/`)

Generated deterministically (store-only, fixed timestamps, no compression variance) by `tools/build-zips.mjs`; regenerate with `node fixtures/synthetic/tools/build-zips.mjs`. A test checks committed ZIPs are byte-identical to generator output.

| File | Contents |
| --- | --- |
| `android-private-with-media.zip` | chat TXT + 1x1 PNG (`IMG-...png`) + tiny WAV (`PTT-...wav`) |
| `android-group-with-media.zip` | chat TXT + placeholder MP4 + tiny WAV (other referenced media intentionally missing) |
| `ios-private-with-media.zip` | `_chat.txt` + 1x1 PNG + tiny WAV |
| `ios-group-with-media.zip` | `_chat.txt` + placeholder MP4 |

Media: the PNG and WAV are valid minimal files. The MP4 is a structural placeholder (`ftyp` + `free` boxes) sufficient for type detection and hashing, not playback.

## Connector events

`connector-events.json`: initial history batch, live upsert, reaction, group metadata, and JID/LID identity link, all with fake IDs. Validated against `connectorEventSchema` in `@social-explorer/contracts`.
