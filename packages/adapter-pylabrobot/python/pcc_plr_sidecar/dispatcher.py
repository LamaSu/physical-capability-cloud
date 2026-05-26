"""JSON-RPC 2.0 method dispatcher.

Method handlers register themselves by name. Dispatch resolves the handler
and awaits it (handlers may be sync or async — both supported). All errors
become JSON-RPC error objects via :func:`format_error`.

This module is intentionally protocol-pure: no PLR imports, no stdio. The
:class:`Server` (server.py) owns transport; the handlers (commands.py) own
domain logic.
"""

from __future__ import annotations
import asyncio
import inspect
import traceback
from typing import Any, Awaitable, Callable, Union

# JSON-RPC error codes — mirror the TypeScript adapter's RPC_ERROR_CODES.
RPC_ERROR_CODES = {
    "PARSE_ERROR": -32700,
    "INVALID_REQUEST": -32600,
    "METHOD_NOT_FOUND": -32601,
    "INVALID_PARAMS": -32602,
    "INTERNAL_ERROR": -32603,
    "RETRYABLE": -32001,
    "NON_RETRYABLE": -32002,
    "HARDWARE_UNREACHABLE": -32003,
    "NOT_SUPPORTED": -32004,
    "DEVICE_BUSY": -32005,
    "SIDECAR_RESTART": -32099,
}

HandlerResult = Union[dict, list, str, int, float, bool, None]
Handler = Callable[..., Union[HandlerResult, Awaitable[HandlerResult]]]


class RpcException(Exception):
    """An exception that maps to a specific JSON-RPC error code + data field."""

    def __init__(self, code: int, message: str, data: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class Dispatcher:
    """Registers JSON-RPC method handlers and dispatches incoming calls."""

    def __init__(self) -> None:
        self._handlers: dict[str, Handler] = {}

    def register(self, method: str, handler: Handler) -> None:
        """Register a method handler. The handler receives ``params`` (dict)."""
        if method in self._handlers:
            raise ValueError(f"method already registered: {method}")
        self._handlers[method] = handler

    def has(self, method: str) -> bool:
        return method in self._handlers

    def methods(self) -> list[str]:
        return sorted(self._handlers.keys())

    async def dispatch(self, method: str, params: dict[str, Any]) -> HandlerResult:
        """Call the handler for ``method`` with ``params``. Awaits if async."""
        handler = self._handlers.get(method)
        if handler is None:
            raise RpcException(
                RPC_ERROR_CODES["METHOD_NOT_FOUND"],
                f"method not found: {method}",
            )
        try:
            result = handler(params)
            if inspect.isawaitable(result):
                result = await result
            return result
        except RpcException:
            raise
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            raise RpcException(
                RPC_ERROR_CODES["INTERNAL_ERROR"],
                str(e),
                {
                    "plrException": type(e).__name__,
                    "traceback": traceback.format_exc(),
                },
            ) from e


def format_error(code: int, message: str, data: dict | None = None) -> dict:
    """Build a JSON-RPC error object (no envelope)."""
    obj: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        obj["data"] = data
    return obj
