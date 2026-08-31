#!/usr/bin/env python3
"""Send bounded, authenticated lifecycle callbacks to the cloud coordinator."""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, parse, request

MAX_MANIFEST_BYTES = 16 * 1024
MAX_RESPONSE_BYTES = 64 * 1024
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
CALLBACK_PATH = re.compile(r"^/v1/jobs/[a-f0-9-]{36}/callback$")


class CallbackError(RuntimeError):
    pass


class _NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def validate_configuration(
    endpoint: str | None = None, token: str | None = None
) -> tuple[str, str]:
    endpoint = (
        os.environ.get("GLIMMER_COORDINATOR_CALLBACK_URL", "")
        if endpoint is None
        else endpoint
    )
    token = (
        os.environ.get("GLIMMER_COORDINATOR_CALLBACK_TOKEN", "")
        if token is None
        else token
    )
    parsed = parse.urlsplit(endpoint)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or not CALLBACK_PATH.fullmatch(parsed.path)
        or not TOKEN_PATTERN.fullmatch(token)
    ):
        raise CallbackError("coordinator callback configuration is invalid")
    canonical = parse.urlunsplit(("https", parsed.netloc, parsed.path, "", ""))
    if canonical != endpoint:
        raise CallbackError("coordinator callback endpoint is not canonical")
    return endpoint, token


def _read_response(response: Any) -> dict[str, Any]:
    declared = response.headers.get("Content-Length")
    if declared and (not declared.isdigit() or int(declared) > MAX_RESPONSE_BYTES):
        raise CallbackError("coordinator response is too large")
    data = response.read(MAX_RESPONSE_BYTES + 1)
    if len(data) > MAX_RESPONSE_BYTES:
        raise CallbackError("coordinator response is too large")
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CallbackError("coordinator response is invalid") from exc
    if not isinstance(value, dict) or value.get("accepted") is not True:
        raise CallbackError("coordinator rejected the callback")
    return value


def send(
    payload: dict[str, Any],
    attempts: int = 5,
    *,
    endpoint: str | None = None,
    token: str | None = None,
) -> dict[str, Any]:
    endpoint, token = validate_configuration(endpoint, token)
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_RESPONSE_BYTES:
        raise CallbackError("coordinator callback is too large")
    opener = request.build_opener(
        _NoRedirect(), request.HTTPSHandler(context=ssl.create_default_context())
    )
    last_error: BaseException | None = None
    for attempt in range(attempts):
        callback = request.Request(
            endpoint,
            data=body,
            method="POST",
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with opener.open(callback, timeout=10) as response:
                if response.status < 200 or response.status >= 300:
                    raise CallbackError("coordinator returned an error")
                return _read_response(response)
        except (OSError, error.HTTPError, error.URLError, CallbackError) as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(min(8, 2**attempt))
    raise CallbackError("coordinator callback failed") from last_error


def _json_document(path: Path) -> dict[str, Any]:
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise CallbackError("cache manifest is unavailable") from exc
    if not data or len(data) > MAX_MANIFEST_BYTES:
        raise CallbackError("cache manifest size is invalid")
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CallbackError("cache manifest is invalid") from exc
    if not isinstance(value, dict):
        raise CallbackError("cache manifest is invalid")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    attestation = commands.add_parser("cache-attestation")
    attestation.add_argument("--attestation", required=True)
    attestation.add_argument("--document-out", required=True)
    attestation.add_argument("--cache-key", required=True)
    published = commands.add_parser("cache-published")
    published.add_argument("--manifest", required=True)
    published.add_argument("--cache-key", required=True)
    invalid = commands.add_parser("cache-invalid")
    invalid.add_argument("--cache-key", required=True)
    heartbeat = commands.add_parser("heartbeat")
    heartbeat.add_argument(
        "--worker-state", choices=("bootstrapping", "ready", "busy"), required=True
    )
    args = parser.parse_args()
    try:
        if args.command == "cache-attestation":
            if not SHA256_PATTERN.fullmatch(args.cache_key):
                raise CallbackError("cache key is invalid")
            payload = {
                "schemaVersion": 1,
                "type": "cache_attestation",
                "observedAt": _timestamp(),
                "cacheKey": args.cache_key,
                "signed": _json_document(Path(args.attestation)),
            }
            result = send(payload)
            document = result.get("document")
            if not isinstance(document, dict):
                raise CallbackError("coordinator did not return a signed document")
            output = Path(args.document_out)
            data = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
            if not data or len(data) > MAX_MANIFEST_BYTES:
                raise CallbackError("signed cache document size is invalid")
            temporary = output.with_name(f".{output.name}.{os.urandom(8).hex()}.tmp")
            temporary.write_bytes(data + b"\n")
            temporary.chmod(0o600)
            os.replace(temporary, output)
            print('{"event":"coordinator_callback_accepted"}')
            return 0
        elif args.command == "cache-published":
            if not SHA256_PATTERN.fullmatch(args.cache_key):
                raise CallbackError("cache key is invalid")
            payload = {
                "schemaVersion": 1,
                "type": "cache_published",
                "observedAt": _timestamp(),
                "cacheKey": args.cache_key,
                "manifest": _json_document(Path(args.manifest)),
            }
        elif args.command == "cache-invalid":
            if not SHA256_PATTERN.fullmatch(args.cache_key):
                raise CallbackError("cache key is invalid")
            payload = {
                "schemaVersion": 1,
                "type": "cache_invalid",
                "observedAt": _timestamp(),
                "cacheKey": args.cache_key,
            }
        else:
            payload = {
                "schemaVersion": 1,
                "type": "heartbeat",
                "observedAt": _timestamp(),
                "workerState": args.worker_state,
            }
        send(payload)
    except CallbackError:
        print('{"event":"coordinator_callback_failed"}', file=sys.stderr)
        return 40
    print('{"event":"coordinator_callback_accepted"}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
