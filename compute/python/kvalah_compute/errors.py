class SidecarError(Exception):
    """Error with a stable code reported to the Node supervisor (never a bare assert)."""
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
