---
name: clone-unit-voice
description: >-
  Clone a Warcraft III unit voice with Fish Audio Drama 3: prepare transcripts,
  write a campaign-register line, generate cached TTS, import into a map. Use
  when cloning a WC3 unit voice, writing a new hero or campaign line, running
  clone-unit-voice, or working under output/fish-voices.
---

# Clone unit voice

CLI: `src/clone-unit-voice.ts`. Human overview: [output/fish-voices/README.md](../../../output/fish-voices/README.md).

Needs `FISH_AUDIO_API_KEY` in `.env`. `--unit` is a fourcc or `object-data/unit-sounds.json` name (`Orex`, `rexxar`).

## Workflow

1. **Prepare** (cheap to re-run; caches clips and ASR):

```
npm run clone-unit-voice -- prepare --unit Orex
```

2. **Read** `output/fish-voices/<fourcc>-<name>/how-he-talks.md` before drafting. Story / cinematic hints match **Campaign dialogue** (first-person, concrete, no narrator). Hero What/Yes/Ready are short barks. Ignore Pissed jokes.

3. **Draft the prompt**, show it to the user, wait. Do not call generate until they approve. Write `output/fish-voices/<fourcc>-<name>/lines/<id>.txt`.

4. **Generate**:

```
npm run clone-unit-voice -- generate --unit Orex --id <id> --text-file output/fish-voices/<fourcc>-<name>/lines/<id>.txt
```

`--force` remakes the Fish voice and/or the line. Default model is `drama-3`. Cached generate is a no-op if `<id>.wav` already exists.

5. **Import** only after they like the take. See Map import below.

## Prompt

Drama 3: brief a voice actor. Emotion, intent, who he is talking to. Docs: https://docs.fish.audio/features/text-to-speech/drama-3

```
[calm, firm, speaking to his companions]
This path is blocked. [short pause] We'll find <emphasis>another</emphasis> way.
```

| Use | Syntax |
| --- | --- |
| Line direction | `[calm, firm, speaking to his companions]` before the words it covers |
| New beat | a new `[…]` when mood changes |
| Pause / breath | `[pause]`, `[short pause]`, `[sigh]`, `[breath]` where it happens |
| One phrase only | paired tags: `emphasis`, `stress`, `whisper`, `soft`, `forceful`, `slow`, `fast` |

Do not:

- Direct timbre the clone already has (`gravelly`, `mid-low register`)
- Use negatives (`not a narrator`, `not flat`) — they get ignored or spoken
- Stack six adjectives, or invent tags like `[heavier]` / `[steady]`

Spoken text: short, campaign register, first-person, concrete. No “scatter” (WC3 order). Map `playSpeech` `text` is spoken words only — strip `[…]` and `<tag>` wrappers.

## Outputs

| File | Use |
| --- | --- |
| `how-he-talks.md` | Diction reference |
| `lines/<id>.txt` | Prompt |
| `lines/<id>.source.wav` | Fish 44.1 kHz original |
| `lines/<id>.wav` | 22050 Hz mono 16-bit, ready for WC3 |
| `voice.json` | Cached Fish model; leave it |

Pack is ≤20 files, ~90 s of campaign audio. Extra campaign clips stay in `clips/Campaign/` for writing, not for the clone.

## Map import

For campaign maps using the sounds watcher, copy the ready 22 kHz mono `.wav` into the map's **source** sounds folder, then use `getSoundGroup` + `playSpeech` on the speaking unit.

```
<campaign-repo>/<map>/sounds/<namespace>/<file>.wav
```

The watcher converts source WAV/OGG/MP3 files to `<map>/maps/assets/wotlk/<map>/sounds/<namespace>/<file>.mp3`, registers imports, and deploys the real audio. Never write only to that generated folder: orphan cleanup deletes files without matching sources. Match the referenced namespace exactly, without an extra `QuestSounds` folder.

`getSoundPath` is `wotlk\<map>\sounds\<namespace>\<file>.mp3`, even when the source is WAV or OGG. Verify the source recording, decoded exported MP3 and duration, `war3map.imp`, and deployed game asset before reporting completion. Packed one-byte placeholders are intentional in this pipeline; check the deployed real file. Do not claim native playback without testing it in WC3. For maps with another build pipeline, follow that project's source/import rules. Do not hard-code machine-absolute paths in the map repo.
