"""PCC PyLabRobot sidecar — JSON-RPC 2.0 stdio bridge.

Module entry point: ``python -m pcc_plr_sidecar`` (see ``__main__.py``).

Public surface (for tests + alternative embedders):

  - ``Server`` — the stdio server (factory + serve loop)
  - ``Dispatcher`` — RPC method registry
  - ``BackendLoader`` — PLR backend factory (chatterbox / ot2 / ...)
  - ``EvidenceHandler`` — Python ``logging.Handler`` that pushes PLR log
    lines + atomic-op records out as JSON-RPC ``evidence`` notifications.
  - ``commands`` — backend.init / backend.run / backend.status / backend.shutdown
"""

from .server import Server
from .dispatcher import Dispatcher
from .backend_loader import BackendLoader
from .evidence import EvidenceHandler
from . import commands

__all__ = [
    "Server",
    "Dispatcher",
    "BackendLoader",
    "EvidenceHandler",
    "commands",
]

__version__ = "0.1.0"
