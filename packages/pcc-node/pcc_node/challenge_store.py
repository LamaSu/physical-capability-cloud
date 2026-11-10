"""Keep the gateway's registration challenge and its local restart state."""

import base64
from datetime import datetime, timezone
import hashlib
import json
import logging
import math
import os
import re
import secrets
import stat
import time

from .crypto import default_key_path, _fsync_dir

log = logging.getLogger("pcc-node.challenge-store")
# The node's own rule: wait eleven minutes after receipt or a permanent refusal.
HOLD_SECONDS = 660
_BINDING_FIELDS = {"gateway", "kernelId", "publicKey", "apiKey"}
_RECORD_FIELDS = {"version", "challengeId", "message", "expiresAt", "storedAt", "reuseSeconds"} | _BINDING_FIELDS
_HOLD_FIELDS = {"version", "receivedAt"} | _BINDING_FIELDS
_REFUSAL_FIELDS = {"version", "reason", "refusedAt"} | _BINDING_FIELDS
_TIME = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?Z$")


def _now():
    return time.time()


def wait_until_text(seconds):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(_now() + seconds))


def store_path():
    return os.path.join(os.path.dirname(os.path.abspath(default_key_path())), "registration-challenge.json")


def hold_path():
    return os.path.join(os.path.dirname(store_path()), "registration-hold.json")


def refusal_path():
    return os.path.join(os.path.dirname(store_path()), "registration-refusal.json")


def binding(gateway, kernel_id, public_key, api_key):
    public = public_key[2:] if public_key.lower().startswith("0x") else public_key
    return {"gateway": gateway.rstrip("/"), "kernelId": kernel_id, "publicKey": "0x" + public.lower(),
            "apiKey": hashlib.sha256(("pcc-node registration challenge store v1\n" + api_key).encode("utf-8")).hexdigest()}


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _timestamp(value):
    if not isinstance(value, str):
        raise ValueError("time is not text")
    match = _TIME.fullmatch(value)
    if match is None:
        raise ValueError("time has an unknown format")
    year, month, day, hour, minute, second = (int(part) for part in match.groups()[:6])
    return datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc).timestamp() + float(match.group(7) or 0)


def _reuse_seconds(challenge):
    try:
        raw = base64.b64decode(challenge["message"], validate=True)
        prefix = b"PCC-KERNEL-REG-V1\n"
        if not raw.startswith(prefix):
            raise ValueError("unknown message format")
        fields = json.loads(raw[len(prefix):].decode("utf-8"))
        lifetime = _timestamp(fields["expiresAt"]) - _timestamp(fields["issuedAt"])
    except (ValueError, TypeError, KeyError, OverflowError, OSError):
        lifetime = 600
    return min(480, lifetime - 120)


def _safe_directory(directory):
    if os.name != "posix":
        return False
    info = os.lstat(directory)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        return False
    ancestor = directory
    while True:
        if os.path.lexists(os.path.join(ancestor, ".git")):
            return False
        parent = os.path.dirname(ancestor)
        if parent == ancestor:
            return True
        ancestor = parent


def _write(path_function, record):
    temporary = None
    descriptor = None
    try:
        path = path_function()
        directory = os.path.dirname(path)
        if not _safe_directory(directory):
            raise OSError("the store directory is not safe")
        temporary = os.path.join(directory, "." + os.path.basename(path) + f".{os.getpid()}.{secrets.token_hex(4)}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            descriptor = None
            json.dump(record, stream, sort_keys=True, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
        _fsync_dir(directory)
        return True
    except Exception as error:
        log.warning("Cannot save registration state (%s).", error)
        return False
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def _read(path_function, expected, fields, compare, size_limit, numbers, strings=()):
    descriptor = None
    try:
        if os.name != "posix":
            return None
        path = path_function()
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > size_limit:
            return None
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            return None
        if not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.geteuid() or opened.st_mode & 0o077 or opened.st_size > size_limit:
            return None
        with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
            descriptor = None
            raw = stream.read(size_limit + 1)
        if len(raw.encode("utf-8")) > size_limit:
            return None
        record = json.loads(raw)
        if not isinstance(record, dict) or set(record) != fields:
            return None
        if type(record["version"]) is not int or record["version"] != 1:
            return None
        if any(not isinstance(record[field], str) for field in _BINDING_FIELDS | set(strings)):
            return None
        if any(not _number(record[field]) for field in numbers):
            return None
        if any(record[field] != expected[field] for field in compare):
            return None
        return record
    except Exception as error:
        log.debug("Cannot read registration state (%s).", error)
        return None
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass


def save(bound, challenge):
    """Save an unsent challenge when the key directory is safe; never raise."""
    try:
        reuse = _reuse_seconds(challenge)
        if reuse <= 0:
            return False
        record = dict(bound)
        record.update(version=1, challengeId=challenge["challengeId"], message=challenge["message"],
                      expiresAt=challenge["expiresAt"], storedAt=_now(), reuseSeconds=reuse)
        return _write(store_path, record)
    except Exception as error:
        log.warning("Cannot save registration state (%s).", error)
        return False


def load(bound):
    record = _read(store_path, bound, _RECORD_FIELDS, _BINDING_FIELDS, 16384,
                   ("storedAt", "reuseSeconds"), ("challengeId", "message", "expiresAt"))
    if record is not None and 0 < record["reuseSeconds"] <= 480 and 0 <= _now() - record["storedAt"] <= record["reuseSeconds"]:
        return {field: record[field] for field in ("challengeId", "message", "expiresAt")}
    return None


def remove():
    try:
        os.unlink(store_path())
    except FileNotFoundError:
        pass


def save_hold(bound):
    try:
        record = dict(bound)
        record.update(version=1, receivedAt=_now())
        return _write(hold_path, record)
    except Exception as error:
        log.warning("Cannot save registration state (%s).", error)
        return False


def hold_remaining(bound):
    record = _read(hold_path, bound, _HOLD_FIELDS, {"gateway", "publicKey", "apiKey"}, 4096, ("receivedAt",))
    if record is not None:
        age = _now() - record["receivedAt"]
        if 0 <= age < HOLD_SECONDS:
            return float(HOLD_SECONDS - age)
    return 0.0


def save_refusal(bound, reason):
    try:
        record = dict(bound)
        record.update(version=1, reason=reason, refusedAt=_now())
        return _write(refusal_path, record)
    except Exception as error:
        log.warning("Cannot save registration state (%s).", error)
        return False


def refusal_wait(bound):
    record = _read(refusal_path, bound, _REFUSAL_FIELDS, _BINDING_FIELDS, 4096, ("refusedAt",), ("reason",))
    if record is not None:
        age = _now() - record["refusedAt"]
        if 0 <= age < HOLD_SECONDS:
            return float(HOLD_SECONDS - age), record["reason"]
    return 0.0, None


def _clear(path_function):
    try:
        os.unlink(path_function())
    except FileNotFoundError:
        pass
    except Exception as error:
        log.warning("Cannot clear registration state (%s).", error)


def clear_hold():
    _clear(hold_path)


def clear_refusal():
    _clear(refusal_path)
