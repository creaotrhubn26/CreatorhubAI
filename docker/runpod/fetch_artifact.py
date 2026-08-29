#!/usr/bin/env python3
"""Download one allowlisted HTTPS artifact and verify its SHA-256."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import os
import socket
import ssl
from pathlib import Path
from urllib import parse, request

MAX_ARTIFACT_BYTES = 32 * 1024 * 1024 * 1024


class SafeRedirect(request.HTTPRedirectHandler):
    def __init__(self, allowed_hosts: set[str]):
        self.allowed_hosts = allowed_hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl, self.allowed_hosts)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def validate_url(value: str, allowed_hosts: set[str]) -> str:
    parsed = parse.urlsplit(value)
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or not host
        or parsed.username
        or parsed.password
        or parsed.fragment
        or host not in allowed_hosts
    ):
        raise ValueError("artifact URL is outside the HTTPS host allowlist")
    for result in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM):
        address = ipaddress.ip_address(result[4][0])
        if not address.is_global:
            raise ValueError("artifact host resolved to a non-public address")
    return value


def fetch(url: str, expected_sha256: str, target: Path, allowed_hosts: set[str]) -> None:
    if len(expected_sha256) != 64 or any(char not in "0123456789abcdef" for char in expected_sha256):
        raise ValueError("artifact SHA-256 is invalid")
    validate_url(url, allowed_hosts)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if target.is_file():
        digest = hashlib.sha256()
        with open(target, "rb") as existing:
            for chunk in iter(lambda: existing.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() == expected_sha256:
            return
    temporary = target.with_name(f".{target.name}.{os.getpid()}.partial")
    opener = request.build_opener(SafeRedirect(allowed_hosts), request.HTTPSHandler(context=ssl.create_default_context()))
    digest = hashlib.sha256()
    total = 0
    try:
        with opener.open(request.Request(url, headers={"User-Agent": "glimmer-worker/1"}), timeout=30) as response:
            declared = int(response.headers.get("Content-Length") or 0)
            if declared > MAX_ARTIFACT_BYTES:
                raise ValueError("artifact exceeds the safe size limit")
            with open(temporary, "xb") as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_ARTIFACT_BYTES:
                        raise ValueError("artifact exceeds the safe size limit")
                    digest.update(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
        if digest.hexdigest() != expected_sha256:
            raise ValueError("artifact checksum does not match")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allowed-host", action="append", required=True)
    args = parser.parse_args()
    hosts = {value.strip().lower() for value in args.allowed_host if value.strip()}
    fetch(args.url, args.sha256.lower(), Path(args.output), hosts)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
