class LiquidHandlerChatterboxBackend:
    def __init__(self, num_channels=8):
        self.num_channels = num_channels


class OpentronsOT2Backend:
    num_channels = 2  # the OT-2's left and right mounts

    def __init__(self, host, port=31950):
        self.host = host
        self.port = port
