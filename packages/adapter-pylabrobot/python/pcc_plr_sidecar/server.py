"""Stdio JSON-RPC server.

Owns the asyncio event loop, stdin reader, stdout writer (with mutex), and
the dispatcher. Wires the :class:`EvidenceHandler` into Python's logging
module so PLR log records auto-flow into evidence notifications during a
recording window.

Wire format: newline-delimited JSON, one message per line, exchanged over
stdin / stdout. Stderr is uncaptured (free-form Python logs).
"""

from __future__ import annotations
import asyncio
import json
import logging
import sys
from dataclasses import dataclass
from typing import Any, Optional

from .backend_loader import BackendLoader
from .commands import Commands
from .dispatcher import Dispatcher, RpcException, format_error, RPC_ERROR_CODES
from .evidence import EvidenceHandler

log = logging.getLogger("pcc_plr_sidecar.server")


class Server:
    """Long-running stdio JSON-RPC 2.0 server.

    Construction is cheap; ``serve()`` is the long-running coroutine. Tests
    can also drive the server programmatically by calling ``handle_line``
    directly without spawning an actual stdio loop.
    """

    def __init__(
        self,
        stdin: Optional[Any] = None,
        stdout: Optional[Any] = None,
        loader: Optional[BackendLoader] = None,
    ) -> None:
        self._stdin = stdin
        self._stdout = stdout
        self.loader = loader or BackendLoader()
        self.dispatcher = Dispatcher()
        self._stdout_lock = asyncio.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self.evidence = EvidenceHandler(writer=self.write_notification)
        self.commands = Commands(self.loader, self.evidence)
        self.commands.register_all(self.dispatcher)
        # Tee PLR log records into the evidence pipeline. Tests that want
        # to silence this can call ``logging.getLogger("pylabrobot").removeHandler(self.evidence)``.
        logging.getLogger("pylabrobot").addHandler(self.evidence)
        logging.getLogger("pcc_plr_sidecar.run").addHandler(self.evidence)

    # ── server lifecycle ──────────────────────────────────────────────────

    async def serve(self) -> None:
        """Run the stdio JSON-RPC loop until stdin EOFs."""
        self._loop = asyncio.get_running_loop()
        self.evidence.attach_loop(self._loop)
        reader = await self._make_stdin_reader()
        await self.write_notification(
            "lifecycle",
            {"phase": "ready", "methods": self.dispatcher.methods()},
        )
        try:
            while True:
                line = await reader.readline()
                if not line:
                    log.info("stdin EOF; shutting down")
                    return
                # Schedule the handler so we don't block subsequent reads on a
                # slow handler. Concurrency is bounded by Python's asyncio
                # scheduler — single-threaded co-op.
                asyncio.create_task(self.handle_line(line.decode("utf-8", errors="replace")))
        finally:
            await self._shutdown_devices()

    async def _make_stdin_reader(self) -> asyncio.StreamReader:
        if self._stdin is not None:
            # Test path: stdin is already an asyncio StreamReader.
            return self._stdin
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, sys.stdin)
        return reader

    async def _shutdown_devices(self) -> None:
        for h in list(self.loader.list()):
            try:
                await self.loader.unload(h.device_id)
            except Exception as e:  # noqa: BLE001
                log.warning("unload %s raised: %s", h.device_id, e)

    # ── message handling ──────────────────────────────────────────────────

    async def handle_line(self, raw: str) -> None:
        # Bind the evidence handler's loop lazily so in-process tests that
        # call handle_line directly (skipping serve()) still get a loop.
        if self._loop is None:
            try:
                self._loop = asyncio.get_running_loop()
                self.evidence.attach_loop(self._loop)
            except RuntimeError:
                pass
        raw = raw.strip()
        if not raw:
            return
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError as e:
            await self.write_response(None, error=format_error(
                RPC_ERROR_CODES["PARSE_ERROR"], f"parse error: {e}",
            ))
            return
        if not isinstance(msg, dict):
            await self.write_response(None, error=format_error(
                RPC_ERROR_CODES["INVALID_REQUEST"], "request must be a JSON object",
            ))
            return
        msg_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        if not isinstance(method, str):
            await self.write_response(msg_id, error=format_error(
                RPC_ERROR_CODES["INVALID_REQUEST"], "method missing or not a string",
            ))
            return
        if not isinstance(params, dict):
            await self.write_response(msg_id, error=format_error(
                RPC_ERROR_CODES["INVALID_PARAMS"], "params must be an object",
            ))
            return
        # If there's no id this is a notification — no response is sent.
        is_notification = msg_id is None
        try:
            result = await self.dispatcher.dispatch(method, params)
            if not is_notification:
                await self.write_response(msg_id, result=result)
        except RpcException as e:
            if not is_notification:
                await self.write_response(msg_id, error=format_error(e.code, e.message, e.data))
        except Exception as e:  # noqa: BLE001
            log.exception("unhandled exception in dispatcher")
            if not is_notification:
                await self.write_response(msg_id, error=format_error(
                    RPC_ERROR_CODES["INTERNAL_ERROR"], str(e),
                    {"plrException": type(e).__name__},
                ))

    # ── outbound writes ───────────────────────────────────────────────────

    async def write_response(self, msg_id: Any, *, result: Any = None, error: dict | None = None) -> None:
        body: dict[str, Any] = {"jsonrpc": "2.0", "id": msg_id}
        if error is not None:
            body["error"] = error
        else:
            body["result"] = result
        await self._write_line(json.dumps(body, separators=(",", ":")))

    async def write_notification(self, method: str, params: dict[str, Any]) -> None:
        body = {"jsonrpc": "2.0", "method": method, "params": params}
        await self._write_line(json.dumps(body, separators=(",", ":")))

    async def _write_line(self, line: str) -> None:
        async with self._stdout_lock:
            if self._stdout is not None:
                # Test path: stdout is a buffer with .write()/.flush()
                self._stdout.write(line + "\n")
                flush = getattr(self._stdout, "flush", None)
                if flush:
                    flush()
            else:
                sys.stdout.write(line + "\n")
                sys.stdout.flush()
