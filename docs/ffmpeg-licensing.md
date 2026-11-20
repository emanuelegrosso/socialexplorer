# FFmpeg licensing profile (SocialExplorer movie export)

SocialExplorer renders movies locally via a **supervised** `ffmpeg` child process (validated argument arrays, `shell: false`, path containment). This note records which codecs we target for **redistribution-friendly** builds and what we deliberately avoid.

## Goals

- Ship or document an FFmpeg build that keeps **LGPL** (or permissive) obligations manageable.
- Prefer **royalty-free** video/audio codecs for default export.
- Never rely on **shell-string** invocation or path injection when building filter graphs.

## Approved default profiles

These are defined in `@social-explorer/movie-composer` (`CODEC_PROFILES`):

| Profile ID      | Container | Video            | Audio   | Notes |
|-----------------|-----------|------------------|---------|-------|
| `webm-vp9`      | WebM      | libvpx-vp9       | libopus | Preferred default: VP9 + Opus are royalty-free; WebM is widely playable in browsers. |
| `mp4-openh264`  | MP4       | libopenh264      | native AAC | H.264 via [Cisco OpenH264](https://www.openh264.org/) (BSD + binary patent licence terms for distribution). AAC via FFmpeg's native encoder (check your build's licence flags). |
| `mp4-mpeg4`     | MP4       | mpeg4 (Part 2)   | native AAC | LGPL-native fallback when OpenH264 is absent; larger files, broad compatibility. |

Profile selection (`selectProfile`) probes `-encoders` and picks the first profile whose **both** video and audio encoders exist.

## Explicitly excluded from our preset list

We do **not** reference these in export presets because they commonly imply **GPL** or **non-free** FFmpeg builds when linked statically or bundled for distribution:

- **libx264** / **libx265** (x264/x265 GPL)
- **libfdk_aac** (non-free)
- Hardware encoders with vendor-specific redistribution constraints unless separately reviewed

If a user's system FFmpeg only exposes GPL encoders, export should fall back to `mp4-mpeg4` or `webm-vp9`, or surface a clear error—never silently switch to GPL-only codecs in our manifest.

## OpenH264 considerations

- OpenH264 is **not** GPL; Cisco provides patent licence terms for binary redistribution of their encoder.
- FFmpeg's `libopenh264` wrapper may still require that **your** distribution complies with Cisco's OpenH264 binary licence if you ship their library.
- For app stores/desktop bundles, legal review should confirm whether you ship OpenH264 binaries or require the user to supply FFmpeg.

## VP9 / Opus considerations

- **libvpx-vp9** and **libopus** are suitable for royalty-free redistribution in many jurisdictions; verify your packaging (static vs dynamic link) with counsel.
- VP9 encode can be CPU-heavy; our runner supports timeouts, cancellation, and progress events so the UI never blocks on render.

## User-supplied FFmpeg

Users may point rendering at a system `ffmpeg`. We validate arguments and paths regardless of build. **Rights-aware audio** and **export privacy** policies are independent of which FFmpeg build is installed.

## Operational safety (implementation)

- Arguments are a `string[]` passed to `spawn(executable, args, { shell: false })`.
- Input/output paths must resolve under caller-supplied roots (`assertSafeInputFile` / `assertSafeOutputPath`).
- User-visible text in filtergraphs uses **drawtext** with **textfile** (no inline shell metacharacters).
- Renders use private temp dirs (`social-explorer-render-*`) removed on success or failure; stale dirs can be swept with `cleanupStaleRenderDirs`.

## Further reading

- FFmpeg licence and FAQ: https://ffmpeg.org/legal.html
- OpenH264: https://www.openh264.org/