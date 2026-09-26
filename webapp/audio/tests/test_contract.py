"""The code must follow spec/ (the source of truth): schemas of every response, and paths/methods/codes."""

import json

import jsonschema
import pytest

from conftest import SPEC_DIR

REQUEST_SCHEMA = json.loads((SPEC_DIR / "audio-request.schema.json").read_text())
RESPONSE_SCHEMA = json.loads((SPEC_DIR / "audio-response.schema.json").read_text())
OPENAPI = json.loads((SPEC_DIR / "audio-service.openapi.json").read_text())
FORMATS = jsonschema.Draft202012Validator.FORMAT_CHECKER


def check_response(obj):
    jsonschema.Draft202012Validator(RESPONSE_SCHEMA, format_checker=FORMATS).validate(obj)


def test_every_response_matches_the_schema(client):
    created = client.post("/audio", json={"text": "Is anyone there?", "emotion": "eerie"}).json()
    check_response(created)
    check_response(client.get(f"/audio/{created['id']}").json())
    for item in client.get("/audio/list").json():
        check_response(item)


@pytest.mark.parametrize("example", REQUEST_SCHEMA["examples"])
def test_spec_request_examples_are_accepted(client, example):
    jsonschema.validate(example, REQUEST_SCHEMA)
    assert client.post("/audio", json=example).status_code == 201


def test_errors_are_flat(client):
    body = client.get("/audio/nope").json()
    jsonschema.validate(body, OPENAPI["components"]["schemas"]["Error"])
    assert set(body) == {"error", "message"}


def test_paths_methods_and_codes_match_spec(client):
    ours = client.get("/openapi.json").json()["paths"]
    for path, ops in OPENAPI["paths"].items():
        assert path in ours, path
        for method, op in ops.items():
            assert method in ours[path], (path, method)
            assert set(ours[path][method]["responses"]) == set(op["responses"]), (path, method)
            assert ours[path][method]["operationId"] == op["operationId"]
    assert set(ours) == set(OPENAPI["paths"])  # nothing public beyond the contract (healthz is hidden)
