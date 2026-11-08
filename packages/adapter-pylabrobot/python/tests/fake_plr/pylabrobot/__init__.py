"""A tiny FAKE of the pylabrobot API surface the PCC sidecar uses (tests only).

It is PCC's own code, not pylabrobot. It exists so the sidecar's dispatch and
fail-loud paths can be tested without installing the real library (the goal's
clean-room rule). The real-library tests live in test_plr_real.py and skip
unless the genuine pylabrobot is installed.
"""

PCC_FAKE = True
