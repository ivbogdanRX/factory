#!/usr/bin/env python3
"""Transcribe an audio file with faster-whisper and emit word-level timings.

Usage: transcribe_fw.py <audio_path> [model]
Output (stdout): JSON array of {"text", "start", "end"} with times in seconds.

Word timestamps from faster-whisper use cross-attention alignment, which is far
more accurate than whisper.cpp's segment-split heuristic — so the caption
highlight lands on each word as it's actually spoken.
"""
import json
import sys

from faster_whisper import WhisperModel


def main() -> int:
    if len(sys.argv) < 2:
        print("[]")
        return 1
    audio = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base.en"

    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(
        audio,
        language="en",
        word_timestamps=True,
        vad_filter=True,
    )

    words = []
    for seg in segments:
        for w in seg.words or []:
            text = (w.word or "").strip()
            if not text:
                continue
            words.append(
                {"text": text, "start": float(w.start), "end": float(w.end)}
            )

    print(json.dumps(words))
    return 0


if __name__ == "__main__":
    sys.exit(main())
