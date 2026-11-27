# Implementation report

The release implements P0 runtime residency, negotiated resumable upload, durable metadata recovery, status reconciliation, same-parent carry-forward, transfer-specific deadlines and circuit breaker, protected traffic admission and separate LAN/WAN allowances. Previous workers retain the legacy upload route. Existing experiments keep their stored config and new experiments enable accepted-update carry-forward by default.

Experimental quorum modes require explicit opt-in and a minimum independent-device count and token budget. Adaptive scheduling accepts an explicit per-slot step plan with the same total sample budget. Claims prefer larger assignments for a device with a higher recent effective token rate. The automatic network-aware assignment experiment is isolated in the simulator. Neither experiment is enabled by default.

The main training algorithm and archive tensor formats retain their previous definitions. Voluntary deployment outside the trusted network, full R60 Optimized ablations, alternative-optimizer quality runs and the extended model-quality panel remain separate acceptance work.
