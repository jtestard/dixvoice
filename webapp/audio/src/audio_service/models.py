"""AudioRequest and AudioResponse, as defined in spec/audio-request.schema.json and spec/audio-response.schema.json."""

from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict, Field

UUID4_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


class AudioRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=100, description="Text to generate speech for.")
    emotion: str = Field(min_length=1, max_length=30, description="Emotion the text is spoken with (free text).")
    voiceId: str | None = Field(default=None, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$",
                                description="Optional Gradium voice. When absent, chosen from the emotion and the language.")


class AudioResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Unique identifier (UUID v4).")
    text: str = Field(description="Text the speech was generated from (same as in the AudioRequest).")
    emotion: str = Field(description="Emotion the text is spoken with (same as in the AudioRequest).")
    voiceId: str = Field(description="Gradium voice of the clip: the request's voiceId if given, otherwise the one the service chose.")
    clipUrl: str = Field(description="Public CDN URL of the mp3 file.")


class ErrorBody(BaseModel):
    error: str
    message: str
