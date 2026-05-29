"""Dispatcher tests — registration, async/sync handler resolution, error mapping."""

from __future__ import annotations
import pytest

from pcc_plr_sidecar.dispatcher import (
    Dispatcher,
    RpcException,
    RPC_ERROR_CODES,
    format_error,
)


@pytest.mark.asyncio
async def test_register_and_dispatch_sync_handler():
    d = Dispatcher()

    def handler(params):
        return {"echo": params}

    d.register("test.echo", handler)
    result = await d.dispatch("test.echo", {"hello": "world"})
    assert result == {"echo": {"hello": "world"}}


@pytest.mark.asyncio
async def test_register_and_dispatch_async_handler():
    d = Dispatcher()

    async def handler(params):
        return {"async": True, "params": params}

    d.register("test.async", handler)
    result = await d.dispatch("test.async", {"k": 1})
    assert result == {"async": True, "params": {"k": 1}}


@pytest.mark.asyncio
async def test_unknown_method_raises_method_not_found():
    d = Dispatcher()
    with pytest.raises(RpcException) as ei:
        await d.dispatch("nonexistent", {})
    assert ei.value.code == RPC_ERROR_CODES["METHOD_NOT_FOUND"]


@pytest.mark.asyncio
async def test_rpc_exception_in_handler_propagates_with_code_and_data():
    d = Dispatcher()

    def handler(params):
        raise RpcException(
            RPC_ERROR_CODES["NON_RETRYABLE"],
            "out of tips",
            {"plrException": "NoTipError"},
        )

    d.register("lh.aspirate", handler)
    with pytest.raises(RpcException) as ei:
        await d.dispatch("lh.aspirate", {})
    assert ei.value.code == RPC_ERROR_CODES["NON_RETRYABLE"]
    assert ei.value.message == "out of tips"
    assert ei.value.data == {"plrException": "NoTipError"}


@pytest.mark.asyncio
async def test_unhandled_exception_becomes_internal_error_with_traceback():
    d = Dispatcher()

    def handler(params):
        raise RuntimeError("boom")

    d.register("test.crash", handler)
    with pytest.raises(RpcException) as ei:
        await d.dispatch("test.crash", {})
    assert ei.value.code == RPC_ERROR_CODES["INTERNAL_ERROR"]
    assert "boom" in ei.value.message
    assert ei.value.data["plrException"] == "RuntimeError"
    assert "Traceback" in ei.value.data["traceback"]


def test_register_duplicate_method_raises():
    d = Dispatcher()
    d.register("test.x", lambda p: 1)
    with pytest.raises(ValueError):
        d.register("test.x", lambda p: 2)


def test_methods_returns_sorted():
    d = Dispatcher()
    d.register("z.method", lambda p: None)
    d.register("a.method", lambda p: None)
    assert d.methods() == ["a.method", "z.method"]


def test_has_method():
    d = Dispatcher()
    d.register("test.x", lambda p: 1)
    assert d.has("test.x") is True
    assert d.has("test.y") is False


def test_format_error_with_and_without_data():
    err = format_error(-32602, "bad params")
    assert err == {"code": -32602, "message": "bad params"}
    err2 = format_error(-32603, "internal", {"k": "v"})
    assert err2 == {"code": -32603, "message": "internal", "data": {"k": "v"}}
