"""Fake LiquidHandler: records every call and simulates tips and volumes."""


class NoTipError(Exception):
    pass


class TooLittleLiquidError(Exception):
    pass


class LiquidHandler:
    def __init__(self, backend, deck):
        self.backend = backend
        self.deck = deck
        self.calls = []
        self.head = {}  # channel -> TipSpot the tip came from

    async def setup(self):
        # The real LiquidHandlerChatterboxBackend print()s to stdout like this.
        print("Setting up the liquid handler.")
        self.calls.append(("setup",))

    async def stop(self):
        self.calls.append(("stop",))

    async def pick_up_tips(self, tip_spots, use_channels=None):
        channels = use_channels or list(range(len(tip_spots)))
        for ch, spot in zip(channels, tip_spots):
            if not spot.has_tip:
                raise NoTipError(f"No tip at {spot.name}")
            spot.has_tip = False
            self.head[ch] = spot
        self.calls.append(("pick_up_tips", [s.name for s in tip_spots], use_channels))

    async def drop_tips(self, tip_spots, use_channels=None):
        channels = use_channels or list(range(len(tip_spots)))
        for ch, spot in zip(channels, tip_spots):
            if ch not in self.head:
                raise NoTipError(f"Channel {ch} does not have a tip.")
            del self.head[ch]
            spot.has_tip = True
        self.calls.append(("drop_tips", [s.name for s in tip_spots], use_channels))

    async def return_tips(self, use_channels=None):
        for ch in list(use_channels or self.head.keys()):
            spot = self.head.pop(ch, None)
            if spot is None:
                raise NoTipError(f"Channel {ch} does not have a tip.")
            spot.has_tip = True
        self.calls.append(("return_tips", use_channels))

    def _need_tip(self, channels, n):
        for ch in channels or list(range(n)):
            if ch not in self.head:
                raise NoTipError(f"Channel {ch} does not have a tip.")

    async def aspirate(self, resources, vols, use_channels=None):
        self._need_tip(use_channels, len(resources))
        for well, v in zip(resources, vols):
            if well.volume < v:
                raise TooLittleLiquidError(f"{well.name} holds {well.volume} uL, need {v}")
            well.volume -= v
        self.calls.append(("aspirate", [w.name for w in resources], list(vols), use_channels))

    async def dispense(self, resources, vols, use_channels=None):
        self._need_tip(use_channels, len(resources))
        for well, v in zip(resources, vols):
            well.volume += v
        self.calls.append(("dispense", [w.name for w in resources], list(vols), use_channels))
