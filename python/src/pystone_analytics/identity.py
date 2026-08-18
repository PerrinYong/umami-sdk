from __future__ import annotations

import base64
import hashlib
import hmac
from uuid import uuid4


def create_installation_id() -> str:
    return str(uuid4())


def derive_installation_subject_id(product_scope: str, installation_id: str) -> str:
    if not product_scope or not installation_id:
        raise ValueError("product_scope and installation_id are required")
    digest = hashlib.sha256(f"{product_scope}\0{installation_id}".encode()).digest()
    return _base64url(digest)


def derive_user_subject_id(product_key: bytes, internal_user_id: str) -> str:
    if len(product_key) < 32 or not internal_user_id:
        raise ValueError("a 32-byte product_key and internal_user_id are required")
    return _base64url(hmac.new(product_key, internal_user_id.encode(), hashlib.sha256).digest())


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")
