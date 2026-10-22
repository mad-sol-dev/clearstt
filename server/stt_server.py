"""Local STT service with an OpenAI-compatible transcription endpoint.

Backend: faster-whisper (CTranslate2) on a CUDA GPU.

Endpoints:
    POST /v1/audio/transcriptions   (multipart, OpenAI-compatible)
    POST /v1/dictate                (multipart, dictation from another device -> focused field)
    POST /v1/key                    (form key=Return: press a key in the focused window)
    GET  /health
"""

from __future__ import annotations

import asyncio
import hmac
import ipaddress
import logging
import os
import tempfile
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

from textpost import build_text_with_pauses
from textpost import remove_fillers as strip_fillers

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOG = logging.getLogger("stt")

MODEL_NAME = os.environ.get("STT_MODEL", "large-v3")
DEVICE = os.environ.get("STT_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("STT_COMPUTE_TYPE", "int8_float16")
DEFAULT_LANGUAGE = os.environ.get("STT_LANGUAGE") or None

# Auto-detect language: the value "auto" in the language field. An *empty*
# field doesn't work for this — that already means "use the default".
LANGUAGE_AUTO = "auto"
# When Whisper's language detection is uncertain, guessing is worse than the
# default: short utterances ("Yeah, exactly.") carry too few features.
LANGUAGE_FALLBACK = os.environ.get("STT_LANGUAGE_FALLBACK", "de")
LANGUAGE_DETECT_THRESHOLD = float(os.environ.get("STT_LANGUAGE_DETECT_THRESHOLD", "0.6"))
API_KEY = os.environ.get("STT_API_KEY") or None
IDLE_UNLOAD_SECONDS = int(os.environ.get("STT_IDLE_UNLOAD_SECONDS", "900"))
MAX_UPLOAD_BYTES = int(os.environ.get("STT_MAX_UPLOAD_BYTES", str(64 * 1024 * 1024)))

# Mechanical post-processing (no LLM)
DEFAULT_REMOVE_FILLERS = os.environ.get("STT_REMOVE_FILLERS", "1") == "1"
DEFAULT_MARK_PAUSES = os.environ.get("STT_MARK_PAUSES", "1") == "1"
PAUSE_THRESHOLD = float(os.environ.get("STT_PAUSE_THRESHOLD", "0.8"))
PARAGRAPH_THRESHOLD = float(os.environ.get("STT_PARAGRAPH_THRESHOLD", "2.0"))
PAUSE_MARKER = os.environ.get("STT_PAUSE_MARKER", " … ")

# Controls the style of the output: Whisper continues the tone of the
# prompt. A cleanly punctuated prompt without filler words pulls in the same
# direction as the filter — just already at recognition time.
DEFAULT_INITIAL_PROMPT = os.environ.get("STT_INITIAL_PROMPT") or None

# Access from other machines (e.g. dictating from a phone over a VPN).
# Without both values nothing changes: only loopback gets in. Loopback still
# needs only STT_API_KEY (if set), so the extension needs no reconfiguring.
# From outside, the sender must be in STT_REMOTE_NETWORKS *and* send
# Bearer STT_REMOTE_API_KEY.
REMOTE_NETWORKS = [
    ipaddress.ip_network(net.strip(), strict=False)
    for net in os.environ.get("STT_REMOTE_NETWORKS", "").split(",")
    if net.strip()
]
REMOTE_API_KEY = os.environ.get("STT_REMOTE_API_KEY") or None

# Hand-off to the GNOME extension: it exports this object on the Shell's own
# session-bus connection, so org.gnome.Shell is the destination.
DBUS_DEST = "org.gnome.Shell"
DBUS_PATH = "/org/gnome/Shell/Extensions/ClearSTT"
DBUS_INTERFACE = "org.gnome.Shell.Extensions.ClearSTT"


class ModelHolder:
    """Loads the model on the first request and frees VRAM again after idling."""

    def __init__(self) -> None:
        self._model = None
        self._lock = asyncio.Lock()
        self._last_used = 0.0

    @property
    def loaded(self) -> bool:
        return self._model is not None

    async def get(self):
        async with self._lock:
            if self._model is None:
                LOG.info("Loading %s (%s, %s) ...", MODEL_NAME, DEVICE, COMPUTE_TYPE)
                started = time.monotonic()
                from faster_whisper import WhisperModel

                self._model = await asyncio.to_thread(
                    WhisperModel, MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE
                )
                LOG.info("Model loaded in %.1f s", time.monotonic() - started)
            self._last_used = time.monotonic()
            return self._model

    async def unload(self) -> bool:
        """Frees the model and thus its VRAM. Returns True if something was loaded."""
        async with self._lock:
            return self._unload_locked()

    def _unload_locked(self) -> bool:
        if self._model is None:
            return False
        # ctranslate2 frees the memory on destruction; the explicit call
        # additionally clears the device buffer, if one exists.
        try:
            inner = getattr(self._model, "model", None)
            if inner is not None and hasattr(inner, "unload_model"):
                inner.unload_model()
        except Exception:
            LOG.exception("unload_model")
        self._model = None
        import gc

        gc.collect()
        return True

    async def unload_if_idle(self) -> None:
        async with self._lock:
            if self._model is None or IDLE_UNLOAD_SECONDS <= 0:
                return
            if time.monotonic() - self._last_used < IDLE_UNLOAD_SECONDS:
                return
            LOG.info("Idle > %d s — unloading model, freeing VRAM", IDLE_UNLOAD_SECONDS)
            self._unload_locked()


MODEL = ModelHolder()


async def _idle_watchdog() -> None:
    while True:
        await asyncio.sleep(60)
        try:
            await MODEL.unload_if_idle()
        except Exception:
            LOG.exception("idle watchdog")


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_idle_watchdog())
    yield
    task.cancel()


app = FastAPI(title="clearstt", lifespan=lifespan)


def _is_loopback(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@app.middleware("http")
async def _remote_gate(request: Request, call_next):
    """Lets non-loopback in only from STT_REMOTE_NETWORKS with STT_REMOTE_API_KEY."""
    host = request.client.host if request.client else ""
    request.state.remote = not _is_loopback(host)
    if not request.state.remote:
        return await call_next(request)

    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if REMOTE_API_KEY is None or address is None or not any(address in net for net in REMOTE_NETWORKS):
        LOG.warning("Rejected: %s (not in STT_REMOTE_NETWORKS)", host)
        return JSONResponse({"detail": "Access denied"}, status_code=403)
    supplied = request.headers.get("authorization", "")
    if not hmac.compare_digest(supplied.encode(), f"Bearer {REMOTE_API_KEY}".encode()):
        LOG.warning("Rejected: %s (wrong remote key)", host)
        return JSONResponse({"detail": "Invalid API key"}, status_code=401)
    return await call_next(request)


def _check_auth(request: Request, authorization: str | None) -> None:
    # From outside, _remote_gate has already checked the remote key.
    if API_KEY is None or getattr(request.state, "remote", False):
        return
    expected = f"Bearer {API_KEY}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="Invalid API key")


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "loaded": MODEL.loaded,
    }


@app.post("/unload")
async def unload(request: Request, authorization: str | None = Header(None)) -> dict:
    """Unload the model and free VRAM. The next request loads it again."""
    _check_auth(request, authorization)
    was_loaded = await MODEL.unload()
    LOG.info("Unload requested (was loaded: %s)", was_loaded)
    return {"unloaded": was_loaded, "loaded": MODEL.loaded}


async def _transcribe(
    file: UploadFile,
    *,
    language: str | None,
    prompt: str | None,
    temperature: float,
    task: str,
    remove_fillers: bool,
    mark_pauses: bool,
) -> str:
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty audio file")
    if len(payload) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Audio file too large")

    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(payload)
            tmp_path = tmp.name

        whisper = await MODEL.get()
        started = time.monotonic()

        def _run():
            requested_language = (language or DEFAULT_LANGUAGE or "").strip().lower() or None

            def start(language_code):
                return whisper.transcribe(
                    tmp_path,
                    task="translate" if task == "translate" else "transcribe",
                    language=language_code,
                    initial_prompt=prompt or DEFAULT_INITIAL_PROMPT,
                    temperature=temperature,
                    vad_filter=True,
                    vad_parameters={"min_silence_duration_ms": 500},
                    beam_size=5,
                    condition_on_previous_text=False,
                    word_timestamps=mark_pauses,
                )

            detection = None
            if requested_language == LANGUAGE_AUTO:
                # transcribe() already detects the language before it returns
                # the generator — detection costs no separate pass. An
                # unconsumed generator hasn't decoded anything yet, so the
                # second attempt discards almost nothing.
                segments, info = start(None)
                probability = getattr(info, "language_probability", 1.0)
                detection = (getattr(info, "language", "?"), probability)
                if probability < LANGUAGE_DETECT_THRESHOLD:
                    segments, info = start(LANGUAGE_FALLBACK)
                effective_language = getattr(info, "language", None)
            else:
                segments, info = start(requested_language)
                effective_language = requested_language or getattr(info, "language", None)

            collected = list(segments)
            if mark_pauses:
                text = build_text_with_pauses(
                    collected,
                    pause_threshold=PAUSE_THRESHOLD,
                    paragraph_threshold=PARAGRAPH_THRESHOLD,
                    pause_marker=PAUSE_MARKER,
                )
            else:
                text = " ".join(s.text.strip() for s in collected).strip()
            if remove_fillers and task != "translate":
                # The filler word list is language-dependent: "um" is a
                # filler in English, a preposition in German.
                text = strip_fillers(text, effective_language or getattr(info, "language", None))
            return text, info, detection

        text, info, detection = await asyncio.to_thread(_run)
        LOG.info(
            "%.2f s audio -> %d chars in %.2f s (language: %s%s)" + (" [translated]" if task == "translate" else ""),
            getattr(info, "duration", 0.0),
            len(text),
            time.monotonic() - started,
            getattr(info, "language", "?"),
            ""
            if detection is None
            else f", detected: {detection[0]} {detection[1]:.2f}"
            + (f" — below {LANGUAGE_DETECT_THRESHOLD}, falling back to {LANGUAGE_FALLBACK}"
               if detection[1] < LANGUAGE_DETECT_THRESHOLD else ""),
        )
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

    return text


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    request: Request,
    file: UploadFile = File(...),
    model: str | None = Form(None),
    language: str | None = Form(None),
    prompt: str | None = Form(None),
    temperature: float = Form(0.0),
    response_format: str = Form("json"),
    task: str = Form("transcribe"),
    remove_fillers: bool = Form(DEFAULT_REMOVE_FILLERS),
    mark_pauses: bool = Form(DEFAULT_MARK_PAUSES),
    authorization: str | None = Header(None),
):
    _check_auth(request, authorization)
    text = await _transcribe(
        file,
        language=language,
        prompt=prompt,
        temperature=temperature,
        task=task,
        remove_fillers=remove_fillers,
        mark_pauses=mark_pauses,
    )
    if response_format == "text":
        return PlainTextResponse(text)
    return {"text": text}


async def _insert_into_focused_field(text: str) -> None:
    """Hands the text to the GNOME extension, which pastes it.

    busctl rather than gdbus: busctl takes the string as its own argv
    element, gdbus would parse it as GVariant text — quotes in the dictation
    would then need escaping of their own.
    """
    process = await asyncio.create_subprocess_exec(
        "busctl", "--user", "call",
        DBUS_DEST, DBUS_PATH, DBUS_INTERFACE, "InsertText", "s", text,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await asyncio.wait_for(process.communicate(), timeout=10)
    if process.returncode != 0:
        detail = stderr.decode(errors="replace").strip()
        LOG.warning("Pasting via D-Bus failed: %s", detail)
        raise HTTPException(status_code=502, detail=f"Extension not reachable: {detail}")


@app.post("/v1/dictate")
async def dictate(
    request: Request,
    file: UploadFile = File(...),
    language: str | None = Form(None),
    mode: str = Form("paste"),
    remove_fillers: bool = Form(DEFAULT_REMOVE_FILLERS),
    mark_pauses: bool = Form(DEFAULT_MARK_PAUSES),
    authorization: str | None = Header(None),
):
    """Dictation from another device: transcribe and pass on according to mode.

    mode=paste  text lands in the focused field (via the extension)
    mode=text   only return the text
    """
    _check_auth(request, authorization)
    if mode not in ("paste", "text"):
        raise HTTPException(status_code=400, detail=f"Unknown mode: {mode}")

    text = await _transcribe(
        file,
        language=language,
        prompt=None,
        temperature=0.0,
        task="transcribe",
        remove_fillers=remove_fillers,
        mark_pauses=mark_pauses,
    )
    # If pasting fails (screen locked, extension disabled), the text still
    # goes back — the caller can read it out instead of losing the dictation.
    delivered = False
    error = None
    if mode == "paste" and text:
        try:
            await _insert_into_focused_field(text)
            delivered = True
        except HTTPException as exc:
            error = exc.detail
    return {"text": text, "mode": mode, "delivered": delivered, "error": error}


# Must match PRESSABLE_KEYS in the extension, which checks again itself.
PRESSABLE_KEYS = {"Return"}


@app.post("/v1/key")
async def press_key(
    request: Request,
    key: str = Form(...),
    authorization: str | None = Header(None),
):
    """Presses a key in the focused window (e.g. Enter after a remote dictation)."""
    _check_auth(request, authorization)
    if key not in PRESSABLE_KEYS:
        raise HTTPException(status_code=400, detail=f"Key not allowed: {key}")
    process = await asyncio.create_subprocess_exec(
        "busctl", "--user", "call",
        DBUS_DEST, DBUS_PATH, DBUS_INTERFACE, "PressKey", "s", key,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await asyncio.wait_for(process.communicate(), timeout=10)
    if process.returncode != 0:
        detail = stderr.decode(errors="replace").strip()
        LOG.warning("Key press via D-Bus failed: %s", detail)
        raise HTTPException(status_code=502, detail=f"Extension not reachable: {detail}")
    LOG.info("Key pressed: %s", key)
    return {"key": key, "pressed": True}


def main() -> None:
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("STT_HOST", "127.0.0.1"),
        port=int(os.environ.get("STT_PORT", "5112")),
        log_level="info",
    )


if __name__ == "__main__":
    main()
