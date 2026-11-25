"""Backend interface (spec §5): probe, prepare/load, set_adapter, make_optimizer, train_step, get_A/get_B,
optimizer_state/load_optimizer_state, evaluate, metrics, release. Available: 'cuda' (PyTorch + bitsandbytes NF4),
'mlx' (Apple MLX), and test-only 'torch-cpu-test' / 'mock' (refused unless KVALAH_COMPUTE_TEST=1)."""
import os
from ..errors import SidecarError

def make_backend(name):
    test = os.environ.get("KVALAH_COMPUTE_TEST") == "1"
    if name == "cuda":
        from .torch_backend import TorchBackend
        return TorchBackend(device="cuda")
    if name == "mlx":
        from .mlx_backend import MLXBackend
        return MLXBackend()
    if name == "torch-cpu-test" and test:
        from .torch_backend import TorchBackend
        return TorchBackend(device="cpu")
    if name == "mock" and test:
        from .mock_backend import MockBackend
        return MockBackend()
    raise SidecarError("UNSUPPORTED_BACKEND", "backend %r is not available (test-only backends need KVALAH_COMPUTE_TEST=1)" % name)
