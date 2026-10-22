# Credits

## Extension (`extension/`)

`extension/` is a fork of
[d-kurchenko/gnome-shell-extension-stt](https://github.com/d-kurchenko/gnome-shell-extension-stt)
(GPL-2.0-or-later). ClearSTT renames it, swaps the transcription backend
from OpenRouter to a configurable OpenAI-compatible endpoint, and adds
clipboard-safe pasting, a recent-dictations list, in-panel language
selection, cancellable requests, and a few other changes — see the
extension's own commit history for the detailed list. Upstream copyright is
retained in [LICENSE](LICENSE); this is a derivative work, not an
independent implementation.

### UI translations (`extension/locale/`)

The interface has been translated into the following languages by the
upstream project's contributors: Arabic, Bulgarian, Catalan, Czech, German,
Greek, Spanish, Basque, Persian, Finnish, French, Hungarian, Italian,
Japanese, Kannada, Korean, Dutch, Occitan, Polish, Brazilian Portuguese,
Russian, Slovak, Turkish, Ukrainian, and Simplified Chinese.

These `.po` files are carried over unchanged from upstream. Their headers
don't record individual translator names (`Last-Translator:` is empty in
every file), so none are listed here — the credit is to the upstream
project and its contributors collectively.

## Server (`server/`)

`server/` (the FastAPI transcription service and `textpost.py`
post-processing) is original work by M.A.D. Solutions, built on top of the
open-source [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
library. It contains no code carried over from the extension's upstream
project.

## How this project was built

See the "How this was built" section of the [README](README.md) for the
disclosure on LLM-assisted development.
