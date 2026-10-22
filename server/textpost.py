"""Mechanical post-processing of transcripts.

No LLM, no added latency, deterministic: same input, same output.
Only removes and marks, never rephrases.
"""

from __future__ import annotations

import re

# Filler words. Deliberately kept short: "eh", "em", "na" are missing on
# purpose, because they are real German words ("eh klar", "na gut").
FILLER_WORDS = {
    "äh", "ähh", "ähhh", "ähm", "ähmm", "ähem",
    "öh", "öhh", "öhm", "ehm",
    "uh", "uhm",  # Whisper sometimes slips into English on German audio
}

# A filler only in English. "um" is one of the most common German
# prepositions — "Ich komme um 5 Uhr" must not become "Ich komme 5 Uhr".
# Same reasoning that keeps "eh" and "na" out of FILLER_WORDS.
ENGLISH_ONLY_FILLERS = {
    "um", "umm", "er", "err", "erm",
}

# Ambiguous: meaningful as a standalone utterance (doubt, thinking out loud,
# agreement for "mhm"), just a stumble mid-sentence. Removed only in
# embedded position.
# "mm" is deliberately missing: millimetres. "5 mm dick" became "5 dick",
# and "Angabe in mm" has no number in front — so a number check alone
# wouldn't do. A leftover hum is the smaller harm.
AMBIGUOUS_FILLERS = {
    "hm", "hmm", "hmmm", "hmh", "mhm", "mh", "mmh",
}

# Words whose doubling carries meaning and are therefore not collapsed as
# stuttering. An allowlist: one word too many in it lets at most one
# doubling through, one missing eats meaning. Language-agnostic on purpose,
# no case distinction.
LEGITIMATE_DOUBLES = {
    "sehr", "ganz", "ja", "nein", "immer", "nie", "weit", "lang", "viel", "gut",
    # German articles and "sie": "die Frau, die die Tür öffnet", "dass das
    # das Beste ist", "weil Sie sie kennen". Grammatically regular and common
    # — the price is that a stuttered "die die" stays in.
    "der", "die", "das", "den", "dem", "des", "sie",
    "very", "really", "so", "much", "many", "far", "long", "never", "always",
    "no", "yes", "good",
}

_WORD_SPLIT = re.compile(r"(\s+)")
_NUMBER = re.compile(r"^\d+(?:[.,:/]\d+)*$")
_STRIP_EDGES = re.compile(r"^[\W_]+|[\W_]+$", re.UNICODE)


def _core(token: str) -> str:
    """Word without surrounding punctuation, lowercased."""
    return _STRIP_EDGES.sub("", token).lower()


def _is_embedded(tokens: list[str], index: int) -> bool:
    """Is the token mid-sentence, i.e. between two words?

    Not embedded: at the start of the sentence, at the end, right after a
    sentence-final punctuation mark, or as a standalone utterance — that's
    exactly when a "hmm" carries meaning (hesitation, doubt, agreement)
    instead of a mere stumble. A pause marker also counts as a boundary.
    """
    if index == 0 or index == len(tokens) - 1:
        return False

    previous = tokens[index - 1]
    following = tokens[index + 1]

    if previous in {"…", "..."} or following in {"…", "..."}:
        return False
    if re.search(r"[.!?]$", previous):
        return False
    if re.search(r"^[.!?]", following) or re.fullmatch(r"[.!?]+", following):
        return False
    # A capitalized word following punctuation: new sentence.
    if re.search(r"[.!?]+$", tokens[index]):
        return False
    return True


def _fillers_for_language(language: str | None) -> set[str]:
    """Filler words for the detected language.

    The English-only fillers are added only for English text: they collide
    with German word forms. If the language is unknown, it stays with the
    collision-free base set — better one filler too many in the text than a
    swallowed word.
    """
    if language and language.strip().lower().startswith("en"):
        return FILLER_WORDS | ENGLISH_ONLY_FILLERS
    return FILLER_WORDS


def remove_fillers(text: str, language: str | None = None) -> str:
    """Removes filler words and collapses word repetitions (stuttering)."""
    filler_words = _fillers_for_language(language)
    tokens = [t for t in _WORD_SPLIT.split(text) if t and not t.isspace()]

    kept: list[str] = []
    for index, token in enumerate(tokens):
        core = _core(token)
        if not core:
            kept.append(token)
            continue

        is_filler = core in filler_words
        if not is_filler and core in AMBIGUOUS_FILLERS:
            is_filler = _is_embedded(tokens, index)

        if is_filler:
            # Preserve sentence-final punctuation ("... äh." -> "..."),
            # discard commas: the comma belongs to the filler, not the sentence.
            trailing = re.search(r"[.!?]+$", token)
            if trailing and kept:
                kept[-1] = kept[-1].rstrip(".,;:!?") + trailing.group()
            continue
        kept.append(token)

    collapsed: list[str] = []
    for token in kept:
        core = _core(token)
        # Not a stutter: numbers ("11 11", phone numbers) and repetitions
        # across punctuation ("was er hat, hat er verdient", "Ja. Ja.").
        # The price: a stuttered "ich, ich" stays in.
        if (
            collapsed
            and core
            and core == _core(collapsed[-1])
            and not _NUMBER.match(core)
            and not re.search(r"[.,;:!?]$", collapsed[-1])
        ):
            if core in LEGITIMATE_DOUBLES:
                # Allow the first doubling, not further repetitions.
                if len(collapsed) >= 2 and _core(collapsed[-2]) == core:
                    continue
            else:
                # Keep the first token (carries the capitalization), but
                # take over sentence-final punctuation from the last one.
                trailing = re.search(r"[.!?]+$", token)
                base = collapsed[-1].rstrip(".,;:!?")
                collapsed[-1] = base + (trailing.group() if trailing else "")
                continue
        collapsed.append(token)

    result = " ".join(collapsed)
    result = re.sub(r"\s+([.,;:!?])", r"\1", result)
    result = re.sub(r"\s{2,}", " ", result)
    return result.strip()


def build_text_with_pauses(
    segments,
    pause_threshold: float = 0.8,
    paragraph_threshold: float = 2.0,
    pause_marker: str = " … ",
) -> str:
    """Inserts pause markers based on word timestamps.

    Requires `word_timestamps=True` during transcription. Gaps of at least
    `pause_threshold` seconds are marked with `pause_marker`, gaps of at
    least `paragraph_threshold` seconds as a paragraph break.
    """
    pieces: list[str] = []
    previous_end: float | None = None

    for segment in segments:
        words = getattr(segment, "words", None)
        if not words:
            # Without word timestamps, only the segment boundary remains.
            if previous_end is not None:
                gap = segment.start - previous_end
                if gap >= paragraph_threshold:
                    pieces.append("\n\n")
                elif gap >= pause_threshold:
                    pieces.append(pause_marker)
                else:
                    pieces.append(" ")
            pieces.append(segment.text.strip())
            previous_end = segment.end
            continue

        for word in words:
            if previous_end is not None:
                gap = word.start - previous_end
                if gap >= paragraph_threshold:
                    pieces.append("\n\n")
                elif gap >= pause_threshold:
                    pieces.append(pause_marker)
                else:
                    pieces.append(" ")
            pieces.append(word.word.strip())
            previous_end = word.end

    text = "".join(pieces)
    text = re.sub(r"[ ]{2,}", " ", text)
    text = re.sub(r"[ ]*\n\n[ ]*", "\n\n", text)
    return text.strip()
